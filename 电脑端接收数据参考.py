import streamlit as st
import pandas as pd
import threading
import time
import os
import sys
from pythonosc.dispatcher import Dispatcher
from pythonosc.osc_server import BlockingOSCUDPServer
from datetime import datetime, timedelta

# ==========================================
# 核心配置（改这里切换10秒/30秒保存）
# ==========================================
SAVE_INTERVAL_SECONDS = 10  # 可改为 10 或 30，按需调整

# ==========================================
# 1. 建立跨线程共享容器 (线程安全)
# ==========================================
class SharedState:
    def __init__(self):
        self.is_recording = False
        self.recorded_data = []          # 已保存到文件的总数据（内存备份）
        self.batch_cache = []            # 待批量保存的临时缓存
        self.latest_packet = {}
        self.alpha_history = []
        self.lock = threading.Lock()     # 线程锁，防止多线程冲突
        self.temp_file_path = ""         # 本地临时文件路径
        self.temp_file = None            # 临时文件句柄
        self.last_save_time = None       # 上次批量保存时间

# 使用 cache_resource 确保全局唯一（Streamlit 重启不重置）
@st.cache_resource
def get_shared_state():
    return SharedState()

state = get_shared_state()

# ==========================================
# 2. 工具函数：内存占用估算（用于监控）
# ==========================================
def get_object_size(obj, seen=None):
    """递归估算Python对象的内存占用（字节）"""
    size = sys.getsizeof(obj)
    if seen is None:
        seen = set()
    obj_id = id(obj)
    if obj_id in seen:
        return 0
    seen.add(obj_id)
    
    # 递归计算容器内对象大小
    if isinstance(obj, dict):
        size += sum(get_object_size(v, seen) for v in obj.values())
        size += sum(get_object_size(k, seen) for k in obj.keys())
    elif isinstance(obj, (list, tuple, set)):
        size += sum(get_object_size(i, seen) for i in obj)
    return size

# ==========================================
# 3. 批量保存线程（核心逻辑）
# ==========================================
def batch_save_worker():
    """后台线程：按配置间隔批量追加保存数据到本地"""
    while True:
        time.sleep(1)  # 每秒检查一次
        if not state.is_recording:
            continue  # 未录制时跳过
        
        with state.lock:
            now = datetime.now()
            # 判断是否达到保存间隔
            if (state.last_save_time is None) or (now - state.last_save_time >= timedelta(seconds=SAVE_INTERVAL_SECONDS)):
                if state.batch_cache and state.temp_file:
                    try:
                        # 批量追加写入文件（无表头，避免重复）
                        df_batch = pd.DataFrame(state.batch_cache)
                        df_batch.to_csv(
                            state.temp_file,
                            mode='a',
                            header=False,
                            index=False,
                            encoding='utf-8'
                        )
                        # 合并到已保存数据，清空缓存
                        state.recorded_data.extend(state.batch_cache)
                        state.batch_cache = []
                        state.last_save_time = now
                        print(f"✅ 批量保存成功：{len(df_batch)} 条 | 累计：{len(state.recorded_data)} 条 | 时间：{now.strftime('%H:%M:%S')}")
                    except Exception as e:
                        print(f"❌ 批量保存失败：{str(e)}")

# 启动批量保存线程（全局唯一）
@st.cache_resource
def start_batch_save_thread():
    batch_thread = threading.Thread(target=batch_save_worker, daemon=True)
    batch_thread.start()
    return batch_thread

start_batch_save_thread()

# ==========================================
# 4. OSC 数据接收回调
# ==========================================
def osc_handler(address, *args):
    """处理Muse S的OSC数据，仅缓存不实时写文件"""
    timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
    
    with state.lock:
        # 更新最新数据包（用于前端显示）
        state.latest_packet = {
            "addr": address,
            "val": args,
            "time": timestamp
        }
        
        # 录制中则加入批量缓存
        if state.is_recording:
            entry = {
                "timestamp": datetime.now(),
                "address": address
            }
            # 按索引存储多通道数值
            for i, v in enumerate(args):
                entry[f"v{i}"] = v
            state.batch_cache.append(entry)
        
        # 提取Alpha波数据（用于绘图）
        if "alpha_absolute" in address:
            try:
                numeric_args = [x for x in args if isinstance(x, (int, float))]
                if numeric_args:
                    avg_alpha = sum(numeric_args) / len(numeric_args)
                    state.alpha_history.append(avg_alpha)
                    # 只保留最近100个点，防止绘图卡顿
                    if len(state.alpha_history) > 100:
                        state.alpha_history.pop(0)
            except Exception:
                pass

# ==========================================
# 5. 启动OSC服务器（接收Muse数据）
# ==========================================
@st.cache_resource
def start_osc_server():
    dispatcher = Dispatcher()
    dispatcher.map("/muse/*", osc_handler)  # 监听所有/muse开头的OSC地址
    
    ip = "0.0.0.0"  # 监听所有网卡
    port = 5000     # Muse默认OSC端口
    server = BlockingOSCUDPServer((ip, port), dispatcher)
    
    # 后台运行服务器
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    return server_thread

start_osc_server()

# ==========================================
# 6. Streamlit 前端界面
# ==========================================
st.set_page_config(page_title="Muse S 长时间录制面板", layout="wide")
st.title("🧘‍♂️ Muse S 赛博修仙面板（批量保存版）")
st.caption(f"当前配置：每 {SAVE_INTERVAL_SECONDS} 秒批量保存 | 内存友好 · 防崩溃")

# 侧边栏控制台
with st.sidebar:
    st.header("🎛️ 录制控制台")
    
    # 开始/停止录制按钮
    if not state.is_recording:
        if st.button("🔴 开始录制", use_container_width=True, type="primary"):
            with state.lock:
                # 初始化录制状态
                state.recorded_data = []
                state.batch_cache = []
                state.is_recording = True
                state.last_save_time = datetime.now()
                
                # 创建唯一临时文件（按时间戳命名）
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                state.temp_file_path = f"muse_recording_{timestamp}.csv"
                
                # 初始化文件（写入表头）
                if state.temp_file:
                    state.temp_file.close()
                state.temp_file = open(state.temp_file_path, 'w', encoding='utf-8')
                # 预写表头，保证CSV格式正确
                header_df = pd.DataFrame(columns=["timestamp", "address", "v0", "v1", "v2", "v3"])
                header_df.to_csv(state.temp_file, header=True, index=False)
            
            st.rerun()  # 刷新页面更新状态
    else:
        if st.button("⬛ 停止并保存", use_container_width=True, type="secondary"):
            with state.lock:
                state.is_recording = False
                
                # 兜底：保存最后一批未写入的数据
                if state.batch_cache and state.temp_file:
                    try:
                        df_remaining = pd.DataFrame(state.batch_cache)
                        df_remaining.to_csv(state.temp_file, mode='a', header=False, index=False)
                        state.recorded_data.extend(state.batch_cache)
                        state.batch_cache = []
                        print(f"📌 停止录制，兜底保存剩余 {len(df_remaining)} 条数据")
                    except Exception as e:
                        st.error(f"兜底保存失败：{str(e)}")
                
                # 安全关闭文件
                if state.temp_file:
                    state.temp_file.close()
                    state.temp_file = None
            
            st.rerun()

    st.divider()
    
    # 数据状态监控
    st.subheader("📊 数据状态")
    st.metric("已保存数据行数", len(state.recorded_data))
    st.metric("待保存缓存行数", len(state.batch_cache))
    
    # 内存占用监控
    cache_size_bytes = get_object_size(state.batch_cache)
    cache_size_mb = cache_size_bytes / 1024 / 1024
    st.metric("缓存内存占用", f"{cache_size_mb:.2f} MB")
    
    # 下次保存倒计时
    if state.is_recording and state.last_save_time:
        next_save = state.last_save_time + timedelta(seconds=SAVE_INTERVAL_SECONDS)
        countdown = max(0, (next_save - datetime.now()).total_seconds())
        st.metric("下次保存倒计时", f"{countdown:.0f} 秒")

    st.divider()
    
    # 数据下载
    st.subheader("💾 数据下载")
    download_df = None
    # 优先用内存数据，内存丢失则从文件加载
    if len(state.recorded_data) > 0 and not state.is_recording:
        download_df = pd.DataFrame(state.recorded_data)
    elif os.path.exists(state.temp_file_path) and not state.is_recording:
        try:
            download_df = pd.read_csv(state.temp_file_path)
            st.info(f"从本地文件恢复数据：\n{os.path.abspath(state.temp_file_path)}")
        except Exception as e:
            st.error(f"加载本地文件失败：{str(e)}")
    
    # 生成下载按钮
    if download_df is not None and len(download_df) > 0:
        csv_data = download_df.to_csv(index=False, encoding='utf-8').encode('utf-8')
        st.download_button(
            label="📥 下载完整数据 (.csv)",
            data=csv_data,
            file_name=f"muse_complete_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv",
            mime="text/csv",
            use_container_width=True
        )

# 主界面：实时监控
col1, col2 = st.columns([1, 2])
with col1:
    st.subheader("📡 实时数据流")
    status_container = st.empty()
    
    # 实时更新数据流信息
    with status_container.container():
        latest = state.latest_packet
        if latest:
            st.metric("最新OSC地址", latest.get("addr", "N/A"))
            
            # 数值格式化（兼容非数字类型）
            vals = latest.get("val", [])
            val_str = "N/A"
            if len(vals) > 0:
                raw_val = vals[0]
                try:
                    float_val = float(raw_val)
                    val_str = f"{float_val:.4f}"
                except (ValueError, TypeError):
                    val_str = str(raw_val)
            
            st.metric("通道1数值", val_str)
            st.caption(f"更新时间：{latest.get('time')}")
            
            # 录制状态提示
            if state.is_recording:
                st.error(f"🔴 录制中 | 累计已保存：{len(state.recorded_data)} 行")
            else:
                st.success("🟢 待机中 | 等待录制开始")
        else:
            st.warning("⏳ 未检测到Muse数据\n请检查：\n1. 手机端Mind Monitor已开启OSC\n2. IP地址填写正确\n3. 设备已连接Muse S")

with col2:
    st.subheader("🌊 Alpha波趋势")
    chart_container = st.empty()
    
    # 实时绘制Alpha波曲线
    with chart_container.container():
        if state.alpha_history:
            st.line_chart(
                state.alpha_history,
                height=300,
                use_container_width=True
            )
        else:
            st.info("📈 等待Alpha波数据...")

# ==========================================
# 7. 页面刷新循环（非阻塞）
# ==========================================
while True:
    time.sleep(0.5)  # 0.5秒刷新一次前端
    # Streamlit会自动刷新状态，无需额外操作  Streamlit run raw.py