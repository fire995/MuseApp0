import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Platform,
  PermissionsAndroid, TouchableOpacity, Dimensions,
  AppState, Linking
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, {
  Capability, AppKilledPlaybackBehavior, useProgress,
} from 'react-native-track-player';
import * as DocumentPicker from '@react-native-documents/picker';
// @ts-ignore
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import Zip from 'react-native-zip-archive';
import ReactNativeForegroundService from '@supersami/rn-foreground-service';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { decodeEEG, analyzeFrequency, calculateSignalQuality } from './utils/MuseDecoder';

if (!global.Buffer) { global.Buffer = Buffer; }

// 注册前台任务
ReactNativeForegroundService.register({ config: { alert: false, onServiceErrorCallBack: () => { } } });

// ── 常量 ─────────────────────────────────────────────────────────
const bleManager = new BleManager();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// [架构移除] 废弃 WebSocket
// const WS_URL = 'ws://192.168.0.200:8001/ws/eeg'; 
const SCREEN_W = Dimensions.get('window').width - 40;

const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL = '273e0001-4c4d-454d-96be-f03bac821358';
const ATHENA_CHANNELS = ['273e0013', '273e0014', '273e0015', '273e0016']
  .map(id => `${id}-4c4d-454d-96be-f03bac821358`);
const PPG_CHANNELS = ['273e0010', '273e0011']
  .map(id => `${id}-4c4d-454d-96be-f03bac821358`);

// ── Muse BLE 命令（Base64）────────────────────────────────────────
// halt:      \x02h\n
// p1035:     \x06p1035\n  全速模式（EEG 256Hz + PPG，功耗高）
// p21:       \x04p21\n    低功耗模式（EEG 约 50Hz，无 PPG）
// dc001×2:   \x06dc001\n  启动数据流（必须发两次）
// status:    \x02s\n      心跳保活
const CMD_HALT = 'AmgK';
const CMD_PRESET_HI = 'BnAxMDM1Cg==';   // p1035 高速
const CMD_PRESET_LO = 'BHAyMQo=';        // p21   低功耗
const CMD_START = 'BmRjMDAxCg==';   // dc001
const CMD_STATUS = 'AnMK';            // s（心跳）

// ── 类型 ─────────────────────────────────────────────────────────
type SignalLevel = 'good' | 'ok' | 'poor' | 'none';
type SamplingMode = 'dense' | 'sparse';

// ── 进度条（隔离组件，避免主树高频重绘）──────────────────────────
const ProgressBar = () => {
  const { position, duration } = useProgress();
  const fmt = (sec: number) =>
    `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
  const pct = duration > 0 ? (position / duration) * 100 : 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 }}>
      <Text style={s.timeText}>{fmt(position)}</Text>
      <View style={s.barTrack}>
        <View style={[s.barFill, { width: `${pct}%`, backgroundColor: '#3498DB' }]} />
      </View>
      <Text style={[s.timeText, { textAlign: 'right' }]}>{fmt(duration)}</Text>
    </View>
  );
};

// ── Theta 实时波形 ────────────────────────────────────────────────
const ThetaWave = React.memo(({ data }: { data: number[] }) => {
  const W = SCREEN_W - 32, H = 64, pad = 6;
  const pts = data.slice(-60);

  // 调试：记录组件接收到的数据
  if (data.length > 0 && data.length % 10 === 0) {
    console.log(`🎨 ThetaWave 组件: 收到 ${data.length} 个数据点，最近 60 个: ${pts.length} 个`);
  }

  if (pts.length < 2 || pts.every(v => v === 0)) {
    return (
      <View style={[s.waveBox, { height: H, justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: '#444', fontSize: 12 }}>等待数据…（连接头环后约 2 秒出现）</Text>
      </View>
    );
  }

  const mn = Math.min(...pts), mx = Math.max(...pts);
  const range = mx - mn || 1;
  const xs = pts.map((_, i) => pad + (i / (pts.length - 1)) * (W - pad * 2));
  const ys = pts.map(v => H - pad - ((v - mn) / range) * (H - pad * 2));

  return (
    <View style={[s.waveBox, { height: H, width: W }]}>
      {xs.map((x, i) => {
        if (i === 0) return null;
        const dx = x - xs[i - 1], dy = ys[i] - ys[i - 1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.5) return null;
        return (
          <View key={i} style={{
            position: 'absolute',
            left: xs[i - 1] + dx / 2 - len / 2,
            top: ys[i - 1] + dy / 2 - 1,
            width: len, height: 2,
            backgroundColor: '#00B894', borderRadius: 1,
            transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
          }} />
        );
      })}
    </View>
  );
}); // 需要添加这个闭合的括号和分号

// ── 采集时长选择器 ────────────────────────────────────────────────
const DENSE_OPTIONS = [0, 10, 20, 30, 60, 90, 120];
const DenseSelector = ({ value, onChange }: { value: number; onChange: (v: number) => void }) => (
  <View style={{ marginTop: 10 }}>
    <Text style={s.sliderLabel}>
      高速采集时长（入睡前）：
      <Text style={{ color: '#3498DB', fontWeight: '700' }}> {value} 分钟</Text>
    </Text>
    <Text style={s.sliderHint}>
      ⚡ 高速：EEG 256Hz + PPG，头环约 4–5 小时{'\n'}
      🌙 之后自动切低功耗模式：EEG ~50Hz，头环可坚持一整晚
    </Text>
    <View style={s.optRow}>
      {DENSE_OPTIONS.map(v => (
        <TouchableOpacity
          key={v}
          style={[s.optBtn, value === v && s.optBtnOn]}
          onPress={() => onChange(v)}>
          <Text style={[s.optText, value === v && { color: '#fff' }]}>{v}m</Text>
        </TouchableOpacity>
      ))}
    </View>
  </View>
);

// ── 主组件 ───────────────────────────────────────────────────────
export default function App() {
  // 连接 & 状态
  const [battery, setBattery] = useState<number | string>('--');
  const [signalLevel, setSignalLevel] = useState<SignalLevel>('none');
  const [signalScore, setSignalScore] = useState(0);
  const [electrodeQuality, setElectrodeQuality] = useState<Record<string, number>>({
    TP9: 0, AF7: 0, AF8: 0, TP10: 0
  });
  const [packetsRx, setPacketsRx] = useState(0);
  const [samplingMode, setSamplingMode] = useState<SamplingMode>('dense');
  const [savedDeviceId, setSavedDeviceId] = useState<string | null>(null);

  // 波形数据
  const [thetaWave, setThetaWave] = useState<number[]>([]);

  // 音乐
  const [isPlaying, setIsPlaying] = useState(false);
  const [musicName, setMusicName] = useState('未加载音乐');

  // 保存
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);
  const [savePath, setSavePath] = useState('');
  const [denseMins, setDenseMins] = useState(30);

  // 日志
  const [logs, setLogs] = useState<string[]>([]);

  const logFileUri = useRef<string | null>(null);
  const fileBuffer = useRef<string>(''); // 内存写缓冲
  const sessionStartTime = useRef<number>(Date.now());
  const filePartIndex = useRef<number>(1);
  const deviceRef = useRef<Device | null>(null);
  const isConnecting = useRef(false);
  const isAutoRecon = useRef(false);
  const userDisconnect = useRef(false);  // 用户主动断开标志
  const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
  const samplingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 信号平滑（10 帧中位数，彻底消除跳变）
  const signalBuf = useRef<number[]>([]);

  // ── 数据流追踪（用于双因子信号计算 + 诊断） ──────────────────────
  const lastDataTime = useRef<number>(0);          // 最近一次收到数据包的时间
  const dataFlowActive = useRef<boolean>(false);    // 数据流是否已激活
  const packetCountRef = useRef<number>(0);         // 总数据包计数（不触发UI）
  const saveRowCount = useRef<number>(0);           // 保存的行数
  const horseshoeScore = useRef<number>(0);         // 最新佩戴质量分
  const diagnosticTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const dataQualityTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const eegBufRef = useRef<Record<string, number[]>>({
    '0013': [], '0014': [], '0015': [], '0016': []
  });

  // 导入解码器，已在顶部导入

  const addLog = useCallback((msg: string) => {
    console.log(msg);
    setLogs(prev => [msg, ...prev].slice(0, 25));
  }, []);

  // ── 双因子信号质量（佩戴贴合度 + 数据接收率）────────────────────
  // Factor 1: horseshoe 电极贴合度（从 Control 通道解析）
  // Factor 2: 数据接收率（EEG 数据包是否持续到达）
  const recalcSignal = useCallback(() => {
    const hs = horseshoeScore.current;
    const now = Date.now();
    const timeSinceData = now - lastDataTime.current;
    const hasDataFlow = lastDataTime.current > 0 && timeSinceData < 5000; // 5秒内有数据

    // 双因子评分逻辑:
    // - 佩戴质量权重 60%，数据接收权重 40%
    // - 如果完全没有数据流：上限为 25 分（即使佩戴完美）
    // - 如果佩戴差但数据流正常：上限为 40 分
    let combined: number;
    if (!hasDataFlow && hs === 0) {
      combined = 0;  // 完全没信号
    } else if (!hasDataFlow) {
      combined = Math.round(hs * 0.25);  // 佩戴ok但没数据
    } else if (hs === 0) {
      combined = 30;  // 有数据但没佩戴信息（可能 horseshoe 还没上报）
    } else {
      combined = Math.round(hs * 0.6 + (hasDataFlow ? 100 : 0) * 0.4);
    }

    const buf = signalBuf.current;
    buf.push(combined);
    if (buf.length > 10) buf.shift();
    const sorted = [...buf].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    setSignalScore(mid);
    setSignalLevel(mid >= 65 ? 'good' : mid >= 35 ? 'ok' : mid > 0 ? 'poor' : 'none');
  }, []);

  const updateSignal = useCallback((horseshoeRaw: number) => {
    horseshoeScore.current = horseshoeRaw;
    recalcSignal();
  }, [recalcSignal]);

  useEffect(() => {
    setupMusicPlayer();
    // 本地文件系统初始化准备，取代 connectWebSocket()
    initLocalFileSystem();
    checkSavedDevice();

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      // 避坑：系统切后台/非活跃瞬间，强行清空 JS 堆内存缓冲推入文件系统
      if (nextState === 'background' || nextState === 'inactive') {
        flushBufferToFile();
      }
    });

    // ── 周期性诊断报告（每 5 秒） ──────────────────────────────────
    diagnosticTimer.current = setInterval(() => {
      const now = Date.now();
      const timeSinceData = lastDataTime.current > 0 ? ((now - lastDataTime.current) / 1000).toFixed(1) : '从未';
      const pktTotal = packetCountRef.current;
      const saving = isSavingRef.current;
      const bufLen = fileBuffer.current.length;
      const savedRows = saveRowCount.current;
      const fileUri = logFileUri.current;
      const hsScore = horseshoeScore.current;

      // 只在连接状态下输出诊断（避免未连接时刷屏）
      if (pktTotal > 0 || saving) {
        addLog(`── 诊断 ──`);
        addLog(`📡 数据流: ${pktTotal}包 | 最后收到: ${timeSinceData}秒前 | 佩戴分: ${hsScore}`);
        if (saving) {
          addLog(`💾 保存: ${savedRows}行已写入 | 缓冲: ${bufLen}字节 | 文件: ${fileUri ? '✓' : '✗'}`);
        }
      }

      // 同时刷新信号评分（补充数据流因子的时效性）
      if (lastDataTime.current > 0) {
        recalcSignal();
      }
    }, 5000);

    // ── 基于真实波形的信号质量分析（每 2 秒计算一次） ───────────────
    dataQualityTimer.current = setInterval(() => {
      if (lastDataTime.current === 0) return;

      const qs: number[] = [];
      const chMap: Record<string, string> = {
        '0013': 'TP9', '0014': 'AF7', '0015': 'AF8', '0016': 'TP10'
      };

      setElectrodeQuality(prev => {
        let changed = false;
        const next = { ...prev };

        for (const [chId, buf] of Object.entries(eegBufRef.current)) {
          if (buf.length >= 64) {
            // 获取软件分析出的分数
            const softQ = calculateSignalQuality(buf);
            const name = chMap[chId];

            // 策略：取硬件贴合度与软件波形质量的最小值，确保评分严谨
            // 如果硬件说完美但波形全是杂讯，则以波形为准；反之亦然。
            const finalQ = name ? Math.min(next[name], softQ) : softQ;
            qs.push(finalQ);

            if (name && next[name] !== finalQ) {
              next[name] = finalQ;
              changed = true;
            }
          }
        }

        if (qs.length > 0) {
          qs.sort((a, b) => a - b);
          const mid = qs[Math.floor(qs.length / 2)];
          horseshoeScore.current = mid;
          recalcSignal(); // 立即触发 UI 刷新
        }

        return changed ? next : prev;
      });

    }, 2000);

    return () => {
      if (heartbeat.current) clearInterval(heartbeat.current);
      if (samplingTimer.current) clearTimeout(samplingTimer.current);
      if (diagnosticTimer.current) clearInterval(diagnosticTimer.current);
      if (dataQualityTimer.current) clearInterval(dataQualityTimer.current);
      appStateSub.remove();
    };
  }, []);

  // ── 本地存储管理器 ────────────────────────────────────────────────
  const cleanOldLogs = async () => {
    try {
      // @ts-ignore
      const dirUri = FileSystem.documentDirectory;
      if (!dirUri) return;
      // @ts-ignore
      const files = await FileSystem.readDirectoryAsync(dirUri);
      const now = Date.now();
      const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;

      for (const file of files) {
        if (file.endsWith('.csv') || file.endsWith('.zip')) {
          const fileUri = file.startsWith('file://') ? file : dirUri + file;
          // @ts-ignore
          const fileInfo = await FileSystem.getInfoAsync(fileUri);
          // @ts-ignore
          if (fileInfo.exists && !fileInfo.isDirectory && (now - (fileInfo.modificationTime || 0) * 1000) > SEVEN_DAYS_MS) {
            // @ts-ignore
            await FileSystem.deleteAsync(fileUri, { idempotent: true });
            console.log(`🗑️ 存储防爆：已清理过期日志 ${file}`);
          }
        }
      }
    } catch (e) {
      console.warn('清理过期日志失败', e);
    }
  };

  const createNewLogFile = async () => {
    try {
      const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
      // @ts-ignore
      const uri = `${FileSystem.documentDirectory}muse_log_${timeStr}_part${filePartIndex.current}.csv`;
      // @ts-ignore
      await FileSystem.writeAsStringAsync(uri, 'timestamp,channel,data\n', { encoding: FileSystem.EncodingType.UTF8 });
      logFileUri.current = uri;
      addLog(`📄 创建数据分片: part${filePartIndex.current}`);
    } catch (e) {
      addLog(`🔴 创建文件失败: ${e}`);
    }
  };

  const initLocalFileSystem = async () => {
    await cleanOldLogs();
    filePartIndex.current = 1;
    sessionStartTime.current = Date.now();
    await createNewLogFile();

    // 设置默认保存路径
    const defaultFileName = 'muse_data.csv';
    setSavePath(defaultFileName);
    addLog(`📁 文件系统已初始化`);
  };

  const flushBufferToFile = async () => {
    if (!logFileUri.current || fileBuffer.current.length === 0) {
      if (isSavingRef.current && !logFileUri.current) {
        addLog('🔴 [FLUSH] 文件URI为空！无法写入');
      }
      return;
    }

    const chunk = fileBuffer.current;
    const chunkLines = chunk.split('\n').filter(l => l.length > 0).length;
    fileBuffer.current = '';

    try {
      // @ts-ignore
      const fileInfo = await FileSystem.getInfoAsync(logFileUri.current);

      if (!fileInfo.exists) {
        addLog(`📝 [FLUSH] 创建新文件并写入 ${chunkLines} 行`);
        // @ts-ignore
        await FileSystem.writeAsStringAsync(logFileUri.current, 'timestamp,channel,data\n' + chunk, {
          // @ts-ignore
          encoding: FileSystem.EncodingType.UTF8,
        });
      } else {
        // Expo FileSystem append 机制在旧版本有坑（会覆盖全文件），所以此处手动追加
        // @ts-ignore
        const existingData = await FileSystem.readAsStringAsync(logFileUri.current, { encoding: FileSystem.EncodingType.UTF8 });
        // @ts-ignore
        await FileSystem.writeAsStringAsync(logFileUri.current, existingData + chunk, {
          // @ts-ignore
          encoding: FileSystem.EncodingType.UTF8,
        });
      }

      // @ts-ignore
      const newFileInfo = await FileSystem.getInfoAsync(logFileUri.current);
      const sizeKB = newFileInfo.exists && newFileInfo.size ? (newFileInfo.size / 1024).toFixed(1) : 0;
      addLog(`✅ [FLUSH] 追加 ${chunkLines} 行，当前文件大小: ${sizeKB}KB`);

    } catch (e) {
      addLog(`🔴 [FLUSH] 写入异常: ${e}`);
      fileBuffer.current = chunk + fileBuffer.current; // 失败则回退缓冲区
    }
  };

  // 定义一个简单的 4-8Hz 带通近似逻辑（或直接显示滤波后的原始波形）
  const processThetaWave = (rawSamples: number[]) => {
    if (rawSamples.length === 0) return;

    // 使用所有样本点，而不是只取第一个
    setThetaWave(prev => {
      const newData = [...prev, ...rawSamples];
      return newData.slice(-120); // 保留最近 120 个点
    });
  };

  // 添加困意分析函数
  const analyzeDrowsiness = async (thetaEnergy: number, alphaEnergy: number) => {
    // 极简困意启发式算法：Theta 波增加，Alpha 波减弱，标志进入浅睡 (N1期)
    // 此处根据实际算出的能量幅值调整阈值
    const drowsinessScore = (thetaEnergy / (alphaEnergy + 1)) * 100;

    // 满足困意条件且正在播放音乐
    if (drowsinessScore > 75 && isPlaying) {
      const vol = await TrackPlayer.getVolume();
      if (vol > 0.1) {
        // 每次平滑降低 5% 音量
        await TrackPlayer.setVolume(Math.max(0.1, vol - 0.05));
        addLog(`💤 检测到入睡脑波，音量已自动调低至 ${Math.floor((vol - 0.05) * 100)}%`);
      }
    }
  };

  const handleMuseDataPacket = (channel: string, base64Data: string) => {
    // 更新数据流追踪（不触发 UI 渲染，只更新 ref）
    const now = Date.now();
    lastDataTime.current = now;
    packetCountRef.current += 1;
    const pktNum = packetCountRef.current;

    // 首次收到数据时激活数据流并重算信号
    if (!dataFlowActive.current) {
      dataFlowActive.current = true;
      addLog('✅ 数据流已激活 — 首个 EEG 数据包到达');
      recalcSignal();
    }

    // 节流日志：每 50 个包才输出一次（避免 1500+/sec 的 addLog 冻结 UI）
    if (pktNum <= 3 || pktNum % 50 === 0) {
      addLog(`📦 [${channel}] #${pktNum} (${base64Data.length}字节)`);
    }

    // 1. 保存原始数据（仅在采集时）
    if (isSavingRef.current && logFileUri.current) {
      const timestamp = new Date().toISOString();
      fileBuffer.current += `${timestamp},${channel},${base64Data}\n`;
      saveRowCount.current += 1;

      // 每写入第 1、10、100 行时输出诊断（确认保存管线畅通）
      const rows = saveRowCount.current;
      if (rows === 1 || rows === 10 || rows === 100 || rows % 500 === 0) {
        addLog(`💾 [SAVE] 已缓存 ${rows} 行 | 缓冲区: ${fileBuffer.current.length}字节`);
      }

      if (fileBuffer.current.length > 512 * 1024) { // 改为 500KB 刷盘一次，减少磁盘 IO 和读写重叠
        flushBufferToFile();
      }
    } else if (isSavingRef.current && !logFileUri.current && pktNum % 50 === 0) {
      // 诊断：正在保存模式但文件URI为空
      addLog(`🔴 [SAVE] 保存已开启但 logFileUri 为空！数据丢失中`);
    }

    // 2. 实时解码和显示（始终运行）
    // 所有 EEG 通道都用于波形和频域分析
    if (channel === '0013' || channel === '0014' || channel === '0015' || channel === '0016') {
      try {
        const samples = decodeEEG(base64Data);

        if (pktNum <= 3) {
          addLog(`✅ [${channel}] 解码: ${samples.length}样本 [${samples.slice(0, 3).map(v => v.toFixed(1)).join(', ')}...]`);
        }

        if (samples.length > 0) {
          // 维护缓冲（保留最新 256 点 = 1 秒用作信号分析）
          const buf = eegBufRef.current[channel];
          if (buf) {
            buf.push(...samples);
            if (buf.length > 256) {
              buf.splice(0, buf.length - 256);
            }
          }

          processThetaWave(samples);
          // 频域分析
          const { theta, alpha } = analyzeFrequency(samples);
          analyzeDrowsiness(theta, alpha);

          setPacketsRx(prev => prev + 1);
        }
      } catch (e) {
        addLog(`❌ [${channel}] 解码失败: ${e}`);
      }
    }
  };

  // ── 音乐 ─────────────────────────────────────────────────────
  const setupMusicPlayer = async () => {
    try {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification },
        capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      });
    } catch { }
  };

  const pickAndPlay = async () => {
    try {
      const results = await DocumentPicker.pick({ type: [DocumentPicker.types.audio] });
      if (results?.length > 0) {
        const res = results[0];
        await TrackPlayer.reset();
        await TrackPlayer.add({ id: 'meditation', url: res.uri, title: res.name || '冥想音乐', artist: 'MuseApp' });
        setMusicName(res.name || '已加载');
        await TrackPlayer.play();
        setIsPlaying(true);
        addLog(`▶️ ${res.name}`);
      }
    } catch (err) { addLog(`❌ ${err}`); }
  };

  const togglePlay = async () => {
    try {
      if (isPlaying) { await TrackPlayer.pause(); setIsPlaying(false); }
      else { await TrackPlayer.play(); setIsPlaying(true); }
    } catch { }
  };

  // ── 保存控制 ─────────────────────────────────────────────────
  const toggleSave = async () => {
    if (!isSaving) {
      // 开始保存
      setIsSaving(true);
      saveRowCount.current = 0; // 重置行计数器
      addLog(`💾 开始保存数据`);
      addLog(`💾 [SAVE] isSavingRef=${isSavingRef.current} → 即将设为 true`);

      // 创建带时间戳的数据文件并写入 CSV 头
      try {
        const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `muse_data_${timeStr}.csv`;
        // @ts-ignore
        const uri = `${FileSystem.documentDirectory}${fileName}`;
        addLog(`💾 [SAVE] 准备创建文件: ${uri}`);
        // @ts-ignore
        await FileSystem.writeAsStringAsync(uri, 'timestamp,channel,data\n', { encoding: FileSystem.EncodingType.UTF8 });
        logFileUri.current = uri;
        fileBuffer.current = ''; // 清空缓冲区，避免残留旧数据
        setSavePath(fileName);
        addLog(`📁 数据文件已创建: ${fileName}`);
        addLog(`💾 [SAVE] logFileUri 已设置, 数据包到达将自动写入`);
      } catch (e) {
        addLog(`🔴 创建数据文件失败: ${e}`);
        setIsSaving(false);
        return;
      }

      // 启动前台服务和CPU唤醒锁
      startForegroundCapture();
    } else {
      // 停止保存
      setIsSaving(false);
      addLog(`⏹ 停止保存`);
      // 确保最后的缓冲区内容被写入
      await flushBufferToFile();

      // 打印保存统计
      if (logFileUri.current) {
        try {
          // @ts-ignore
          const fileInfo = await FileSystem.getInfoAsync(logFileUri.current);
          // @ts-ignore
          if (fileInfo.exists && fileInfo.size) {
            // @ts-ignore
            const sizeKB = (fileInfo.size / 1024).toFixed(1);
            addLog(`📊 数据文件大小: ${sizeKB} KB`);
          }
        } catch { }
      }
      logFileUri.current = null;

      // 停止前台服务和CPU唤醒锁
      stopForegroundCapture();
    }
  };

  // ── 启动前台采集服务 ──────────────────────────────────────────────
  const startForegroundCapture = async () => {
    if (Platform.OS === 'android') {
      // 1. 拉起 connectedDevice 类型的前台服务通知
      await ReactNativeForegroundService.start({
        id: 144,
        title: 'Muse BCI 采集中',
        message: '正在后台接收并存储脑波数据...',
        icon: 'ic_launcher',
        setOnlyAlertOnce: "true",
        color: '#000000',
        visibility: 'public',
      });

      // 2. 注入 Partial Wake Lock 锁死 CPU 运行态
      await activateKeepAwakeAsync('muse-ble-lock');
    }
  };

  const stopForegroundCapture = () => {
    if (Platform.OS === 'android') {
      ReactNativeForegroundService.stop();
      deactivateKeepAwake('muse-ble-lock');
    }
  };

  // ── 引导用户设置电池优化豁免 ───────────────────────────────────────
  const ensureSamsungUnrestricted = async () => {
    if (Platform.OS === 'android') {
      addLog('⚠️ 【三星设备必做】即将跳转设置。请点击 "电池" -> 选择 "无限制(Unrestricted)"');
      // 延迟2秒让用户看清日志，随后拉起系统设置
      setTimeout(() => {
        Linking.openSettings();
      }, 2000);
    }
  };

  // ── 导出保存的文件 ──────────────────────────────────────────────
  const loadSavedFile = async () => {
    try {
      // 设置默认的保存路径
      const defaultFileName = 'muse_data.csv';
      // @ts-ignore
      logFileUri.current = `${FileSystem.documentDirectory}${defaultFileName}`;
      setSavePath(defaultFileName);
      addLog(`📁 已设置保存路径: ${defaultFileName}`);
    } catch (e) {
      addLog(`🔴 设置保存路径失败: ${e}`);
    }
  };

  const exportSavedFile = async () => {
    try {
      // 先刷新缓冲区
      await flushBufferToFile();

      // @ts-ignore
      const documentDir = FileSystem.documentDirectory;
      if (!documentDir) {
        addLog('🔴 无法访问文档目录');
        return;
      }

      // @ts-ignore
      const files = await FileSystem.readDirectoryAsync(documentDir);
      // 匹配所有数据文件：muse_log_*.csv 和 muse_data_*.csv
      const dataFiles = files.filter(f =>
        (f.startsWith('muse_log_') || f.startsWith('muse_data_')) && f.endsWith('.csv')
      );

      if (dataFiles.length === 0) {
        addLog('⚠️ 没有可导出的数据文件');
        return;
      }

      addLog(`📦 找到 ${dataFiles.length} 个数据文件`);

      // 导出最新的文件（按文件名排序，文件名含时间戳）
      const latestFile = dataFiles.sort().reverse()[0];
      const fileUri = `${documentDir}${latestFile}`;

      // @ts-ignore
      const fileInfo = await FileSystem.getInfoAsync(fileUri);
      // @ts-ignore
      if (fileInfo.exists) {
        // @ts-ignore
        const sizeKB = fileInfo.size ? (fileInfo.size / 1024).toFixed(1) : '未知';
        addLog(`📤 导出文件: ${latestFile} (${sizeKB} KB)`);
        await Sharing.shareAsync(fileUri);
        addLog(`✅ 导出完成: ${latestFile}`);
      } else {
        addLog('⚠️ 文件不存在');
      }
    } catch (e: any) {
      addLog(`🔴 导出失败: ${e.message || e}`);
    }
  };

  // ── BLE 写命令 ────────────────────────────────────────────────
  const write = (device: Device, cmd: string) =>
    device.writeCharacteristicWithoutResponseForService(
      MUSE_SERVICE, MUSE_CONTROL, cmd
    ).catch((error) => {
      addLog(`❌ BLE写入失败: ${error.message}`);
    });

  // ── 自适应采样：发 BLE preset 命令给头环省电 ─────────────────
  //
  //  核心逻辑：
  //  denseMins 分钟后，向头环发 CMD_PRESET_LO (p21)，让头环降低发包频率
  //  → 头环 BLE 功耗降低，电池可坚持整晚
  //  → 同时通知后端切换保存模式
  //
  //  注意：切换 preset 后需要重新发 dc001×2 才能恢复数据流
  //
  const startAdaptiveSampling = (device: Device, denseMinutes: number) => {
    if (samplingTimer.current) clearTimeout(samplingTimer.current);

    if (denseMinutes === 0) {
      // 直接低功耗
      switchToLowPower(device);
      return;
    }

    addLog(`⚡ 高速采集 ${denseMinutes} 分钟后自动切换低功耗`);
    samplingTimer.current = setTimeout(async () => {
      switchToLowPower(device);
    }, denseMinutes * 60 * 1000);
  };

  const switchToLowPower = async (device: Device) => {
    addLog('🌙 切换低功耗模式（p21）…');
    setSamplingMode('sparse');
    // 1. 发低功耗 preset 给头环
    await write(device, CMD_PRESET_LO);
    await sleep(300);
    // 2. 重新启动数据流（切换 preset 后必须重发 dc001×2）
    await write(device, CMD_START);
    await sleep(150);
    await write(device, CMD_START);
    addLog('🌙 低功耗模式已启动（EEG ~50Hz）');
    // 3. 通知后端 - 移除WebSocket通知
    // ws.current?.readyState === WebSocket.OPEN &&
    //   ws.current.send(JSON.stringify({ type: 'sampling_mode', mode: 'sparse' }));
  };

  // ── 完整 Muse 协议启动 ────────────────────────────────────────
  const startMuseProtocol = async (device: Device) => {
    try {
      device.onDisconnected(() => {
        // 检查是否为用户主动断开
        if (userDisconnect.current) {
          addLog('🔌 用户主动断开，不重连');
          return;
        }
        addLog('⚠️ 断开，重连中…');
        if (!isAutoRecon.current) {
          isAutoRecon.current = true;
          reconnectLoop(device);
        }
      });

      let cmdResolve: (() => void) | null = null;
      let ctrlBuf = '';

      device.monitorCharacteristicForService(MUSE_SERVICE, MUSE_CONTROL, (error, char) => {
        if (error) {
          addLog(`⚠️ Control 通道错误: ${error.message}`);
          return;
        }
        if (!char?.value) {
          addLog(`⚠️ Control 通道收到空值`);
          return;
        }

        addLog(`📡 Control 通道收到数据: ${char.value.substring(0, 50)}...`);
        const txt = Buffer.from(char.value, 'base64').toString();
        addLog(`📝 解码后: ${txt.substring(0, 100)}`);
        ctrlBuf += txt;

        // 解析电池 (兼容整数和浮点数如 "bp":89.23)
        const bpMatch = ctrlBuf.match(/"bp"\s*:\s*([\d.]+)/);
        if (bpMatch) {
          const batteryVal = Math.round(parseFloat(bpMatch[1]));
          addLog(`🔋 电池: ${batteryVal}%`);
          setBattery(batteryVal);
          ctrlBuf = ctrlBuf.replace(/"bp"\s*:\s*[\d.]+/, '');
        }

        // 解析硬件佩戴检测 (Horseshoe) - 修复被误删的“佩戴相关”硬逻辑
        // 兼容 Muse 2 ("hs") 和 Muse S ("ch")
        let arrMatch = ctrlBuf.match(/"(?:hs|ch)"\s*:\s*\[([\d.\s,]+)\]/);
        if (arrMatch) {
          const valuesStr = arrMatch[1];
          const values = valuesStr.split(',')
            .map(v => parseFloat(v.trim()))
            .filter(v => !isNaN(v));

          if (values.length >= 4) {
            // 获取 TP9, AF7, AF8, TP10 的硬件佩戴值
            // 硬件值：1=Good(100%), 2=OK(50%), 4=Poor(0%)
            const hardwareScores = values.slice(0, 4).map(vFloat => {
              const vInt = Math.round(vFloat);
              return vInt === 1 ? 100 : vInt === 2 ? 50 : 0;
            });

            setElectrodeQuality(prev => {
              const next = {
                TP9: hardwareScores[0],
                AF7: hardwareScores[1],
                AF8: hardwareScores[2],
                TP10: hardwareScores[3]
              };
              // 计算硬件评分的中位数作为基础参考分
              const sorted = [...hardwareScores].sort((a, b) => a - b);
              horseshoeScore.current = sorted[Math.floor(sorted.length / 2)];
              recalcSignal();
              return next;
            });

            addLog(`👤 硬件佩戴 - TP9:${hardwareScores[0]}% AF7:${hardwareScores[1]}% AF8:${hardwareScores[2]}% TP10:${hardwareScores[3]}%`);
          }
          ctrlBuf = ctrlBuf.replace(/"(?:hs|ch)"\s*:\s*\[[\d.\s,]+\]/, '');
        }

        if (cmdResolve && ctrlBuf.includes('"rc":0')) {
          addLog(`✅ 命令确认收到`);
          cmdResolve(); cmdResolve = null;
          ctrlBuf = ctrlBuf.replace(/"rc":0/, '');
        }
        if (ctrlBuf.length > 500) ctrlBuf = ctrlBuf.slice(-200);
      });

      const sendCmd = (b64: string, label: string) =>
        new Promise<void>(resolve => {
          cmdResolve = resolve;
          write(device, b64);
          setTimeout(() => { cmdResolve && (cmdResolve = null, resolve()); }, 2000);
          addLog(`🔧 ${label}`);
        });

      await sendCmd(CMD_HALT, 'halt');
      await sendCmd(CMD_PRESET_HI, 'preset p1035 高速模式');
      setSamplingMode('dense');

      // 关键修复：增加等待时间让 BLE 栈完成服务发现
      addLog('⏳ 等待 BLE 栈完成服务枚举…');
      await sleep(1500);

      // 验证 Characteristic 可用性
      let availableUUIDs: string[] = [];
      try {
        const services = await device.services();
        const museService = services.find(s => s.uuid.toLowerCase() === MUSE_SERVICE.toLowerCase());
        if (museService) {
          const chars = await museService.characteristics();
          availableUUIDs = chars.map(c => c.uuid.toLowerCase());
          addLog(`✅ 发现 ${chars.length} 个 Characteristic`);
        } else {
          addLog('⚠️ 未找到 Muse 服务，尝试直接订阅…');
        }
      } catch (e) {
        addLog(`⚠️ 服务枚举失败: ${e}，尝试直接订阅…`);
      }

      addLog('🛡️ 订阅 EEG + PPG 通道…');
      addLog(`📋 ATHENA_CHANNELS: ${ATHENA_CHANNELS.join(', ')}`);
      addLog(`📋 PPG_CHANNELS: ${PPG_CHANNELS.join(', ')}`);

      const allChannels = [...ATHENA_CHANNELS, ...PPG_CHANNELS];
      let subscribedCount = 0;

      for (const uuid of allChannels) {
        const uuidLower = uuid.toLowerCase();
        const channelId = uuid.substring(4, 8);

        addLog(`🔍 尝试订阅通道: ${channelId} (UUID: ${uuid})`);

        // 如果有可用 UUID 列表，检查该通道是否存在
        if (availableUUIDs.length > 0 && !availableUUIDs.includes(uuidLower)) {
          addLog(`⏭️ 跳过不可用通道: ${channelId}`);
          continue;
        }

        try {
          // 每个通道独立的回调计数器
          let cbCount = 0;
          device.monitorCharacteristicForService(MUSE_SERVICE, uuid, (error, char) => {
            cbCount++;

            // 节流：只在第1、2、3次和之后每100次打印回调诊断（避免刷屏死机）
            if (cbCount <= 3 || cbCount % 100 === 0) {
              addLog(`📡 [${channelId}] 回调#${cbCount} err:${error ? 'Y' : 'N'} data:${char?.value ? 'Y' : 'N'}`);
            }

            if (error) {
              addLog(`⚠️ 通道异常 [${channelId}]: ${error.message}`);
              return;
            }

            if (char?.value) {
              // 直接分发到处理管线（日志在 handleMuseDataPacket 内节流输出）
              handleMuseDataPacket(channelId, char.value);
            } else if (cbCount <= 5) {
              addLog(`⚠️ [${channelId}] 空数据包`);
            }
          });
          subscribedCount++;
          addLog(`✅ 成功订阅: ${channelId}`);
        } catch (e) {
          addLog(`❌ 订阅失败 [${channelId}]: ${e}`);
        }
      }

      addLog(`📡 已订阅 ${subscribedCount}/${allChannels.length} 个通道`);

      // dc001 × 2（必须发两次才能启动数据流）
      await write(device, CMD_START);
      await sleep(150);
      await write(device, CMD_START);
      addLog('🏁 数据流启动（高速模式）');

      // 心跳保活
      if (heartbeat.current) clearInterval(heartbeat.current);
      setTimeout(() => write(device, CMD_STATUS), 2000);
      heartbeat.current = setInterval(() => write(device, CMD_STATUS), 30000);

      // 启动自适应采样计时器
      startAdaptiveSampling(device, denseMins);

    } catch (e: any) { addLog(`❌ 协议失败: ${e.message}`); }
  };

  const reconnectLoop = async (device: Device) => {
    while (true) {
      try {
        const d = await device.connect();
        await sleep(500);
        await d.discoverAllServicesAndCharacteristics();
        await startMuseProtocol(d);
        isAutoRecon.current = false;
        addLog('✅ 重连成功');
        break;
      } catch { await sleep(3000); }
    }
  };

  // ── 扫描并手动连接 ────────────────────────────────────────────
  const scanAndConnect = async () => {
    if (isConnecting.current) return;
    isConnecting.current = true;
    userDisconnect.current = false;  // 重置用户断开标志

    const state = await bleManager.state();
    if (state !== 'PoweredOn') {
      addLog('❌ 蓝牙未开启'); isConnecting.current = false; return;
    }
    if (Platform.OS === 'android') {
      const g = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      if (g['android.permission.BLUETOOTH_SCAN'] !== PermissionsAndroid.RESULTS.GRANTED) {
        addLog('❌ 缺少蓝牙权限'); isConnecting.current = false; return;
      }
    }

    addLog('📡 扫描中…');
    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) { addLog(`扫描错误: ${error.message}`); isConnecting.current = false; return; }
      if (device?.name?.includes('Muse')) {
        bleManager.stopDeviceScan();
        try {
          addLog(`🔗 发现 ${device.name}，连接中…`);
          const d = await device.connect();
          await AsyncStorage.setItem('MUSE_DEVICE_ID', d.id);
          setSavedDeviceId(d.id);
          await sleep(500);
          await d.discoverAllServicesAndCharacteristics();
          deviceRef.current = d;
          await startMuseProtocol(d);
        } catch (e: any) {
          addLog(`❌ 连接失败: ${e.message}`);
          isConnecting.current = false;
        }
      }
    });
    setTimeout(() => { bleManager.stopDeviceScan(); isConnecting.current = false; }, 10000);
  };

  // ── 启动时自动重连上次设备 ────────────────────────────────────
  const checkSavedDevice = async () => {
    const id = await AsyncStorage.getItem('MUSE_DEVICE_ID');
    if (!id) return;
    setSavedDeviceId(id);
    userDisconnect.current = false;  // 重置用户断开标志
    try {
      addLog('🔄 自动连接上次设备…');
      const d = await bleManager.connectToDevice(id);
      await sleep(500);
      await d.discoverAllServicesAndCharacteristics();
      deviceRef.current = d;
      await startMuseProtocol(d);
      addLog('✅ 自动连接成功');
    } catch {
      addLog('⚠️ 自动连接失败，请手动扫描');
    }
  };

  // ── 清除配对（先断 BLE，再清记录）────────────────────────────
  const clearPairedDevice = async () => {
    // 1. 先设置用户主动断开标志，阻止 onDisconnected 回调触发重连
    userDisconnect.current = true;

    // 2. 停止所有定时器
    if (samplingTimer.current) { clearTimeout(samplingTimer.current); samplingTimer.current = null; }
    if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }

    // 3. 取消自动重连
    isAutoRecon.current = false;

    // 4. 断开 BLE 连接
    try {
      if (deviceRef.current) {
        await deviceRef.current.cancelConnection();
        addLog('🔌 已断开头环 BLE 连接');
      }
    } catch { }

    // 5. 清理状态
    deviceRef.current = null;
    await AsyncStorage.removeItem('MUSE_DEVICE_ID');
    setSavedDeviceId(null);
    setSamplingMode('dense');

    // 6. 延迟重置标志，确保 onDisconnected 回调已完成
    setTimeout(() => {
      userDisconnect.current = false;
    }, 1000);

    addLog('🗑️ 配对已清除，头环已进入配对模式');
  };

  // ── 信号样式 ─────────────────────────────────────────────────
  const SIG = {
    good: { color: '#00E676', label: '信号良好 ✓', desc: '佩戴贴合 · 数据流畅通' },
    ok: { color: '#FFCA28', label: '信号一般 — 调整头环', desc: '请调整佩戴或等待数据流稳定' },
    poor: { color: '#FF5252', label: '信号差 — 重新佩戴', desc: '佩戴松动或数据中断' },
    none: { color: '#555', label: '未连接 / 等待数据', desc: '' },
  }[signalLevel];

  // 数据流子指标（用于 UI 显示）
  const dataFlowColor = packetsRx > 0 ? '#00E676' : '#FF5252';
  const dataFlowLabel = packetsRx > 0 ? '✓ 数据接收中' : '✗ 无数据';

  // ── 渲染 ─────────────────────────────────────────────────────
  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>

      {/* 顶栏 */}
      <View style={s.header}>
        <Text style={s.title}>BCI 冥想平台</Text>
        <View style={s.batteryWrap}>
          <Text style={s.batteryText}>🔋 {battery}{typeof battery === 'number' ? '%' : ''}</Text>
          {typeof battery === 'number' && (
            <View style={[s.batteryBar, { width: Math.max(0, Math.min(100, battery)) * 0.28 }]} />
          )}
        </View>
      </View>

      {/* 信号状态 - 双因子 */}
      <View style={[s.sigCard, { borderColor: SIG.color }]}>
        <View style={{ gap: 6 }}>
          <View style={[s.sigDot, { backgroundColor: SIG.color }]} />
          {/* Horseshoe 硬件佩戴示意图 */}
          <View style={s.horseshoe}>
            {['TP9', 'AF7', 'AF8', 'TP10'].map(ch => (
              <View key={ch} style={[
                s.hsDot,
                { backgroundColor: electrodeQuality[ch] >= 65 ? '#00E676' : electrodeQuality[ch] >= 35 ? '#FFCA28' : '#FF5252' }
              ]} />
            ))}
          </View>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.sigLabel, { color: SIG.color }]}>{SIG.label}</Text>
          {SIG.desc ? <Text style={s.sigDesc}>{SIG.desc}</Text> : null}
          {/* 双因子细节 */}
          <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
            <Text style={{ fontSize: 10, color: '#777' }}>佩戴: {Object.values(electrodeQuality).filter(v => v >= 65).length}/4</Text>
            <Text style={{ fontSize: 10, color: dataFlowColor }}>{dataFlowLabel}</Text>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 4 }}>
          {signalScore > 0 && (
            <Text style={[s.sigScore, { color: SIG.color }]}>{signalScore}%</Text>
          )}
          {packetsRx > 0 && (
            <Text style={s.pktBadge}>
              {packetsRx < 1000 ? `${packetsRx}包` : `${(packetsRx / 1000).toFixed(1)}k包`}
            </Text>
          )}
        </View>
      </View>

      {/* 冥想音乐 */}
      <View style={s.card}>
        <Text style={s.cardTitle}>🎵 冥想音乐</Text>
        <Text style={s.musicName}>{musicName}</Text>
        <View style={s.btnRow}>
          <TouchableOpacity style={s.btnPurple} onPress={pickAndPlay}>
            <Text style={s.btnText}>选择音频</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.btnBlue, isPlaying && s.btnRed]} onPress={togglePlay}>
            <Text style={s.btnText}>{isPlaying ? '⏸ 暂停' : '▶ 播放'}</Text>
          </TouchableOpacity>
        </View>
        <ProgressBar />
      </View>

      {/* Theta 波形 */}
      <View style={s.card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <Text style={s.cardTitle}>〜 Theta 脑波（4–8 Hz）</Text>
          {/* 采样模式小标签 */}
          <View style={[s.modePill,
          samplingMode === 'dense' ? s.modePillDense : s.modePillSparse]}>
            <Text style={s.modePillText}>
              {samplingMode === 'dense' ? '⚡ 高速' : '🌙 低功耗'}
            </Text>
          </View>
        </View>
        <Text style={s.cardSub}>波形动起来 = 数据正在传输 ✓</Text>
        <ThetaWave data={thetaWave} />
      </View>

      {/* 设备连接 */}
      <View style={s.card}>
        <Text style={s.cardTitle}>📡 设备连接</Text>
        <TouchableOpacity style={s.actionBtn} onPress={scanAndConnect}>
          <Text style={s.btnText}>扫描并连接 Muse 头环</Text>
        </TouchableOpacity>
        {savedDeviceId && (
          <TouchableOpacity style={s.clearBtn} onPress={clearPairedDevice}>
            <Text style={s.clearText}>
              🔌 断开并清除配对：{savedDeviceId.substring(0, 14)}…
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* 数据采集保存 */}
      <View style={s.card}>
        <Text style={s.cardTitle}>💾 数据采集</Text>
        <Text style={s.cardSub}>
          保存内容：EEG 全通道原始波形 · PPG 红外/红光（供 HRV + SpO2 分析）
        </Text>
        <DenseSelector value={denseMins} onChange={setDenseMins} />

        {isSaving && (
          <View style={[s.modeBadge,
          samplingMode === 'dense' ? s.modeBadgeDense : s.modeBadgeSparse]}>
            <Text style={s.modeBadgeText}>
              {samplingMode === 'dense'
                ? `⚡ 高速采集中 · 头环 p1035（256Hz）`
                : '🌙 低功耗采集中 · 头环 p21（~50Hz）'}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[s.saveBtn, isSaving && s.saveBtnOn]}
          onPress={toggleSave}>
          <Text style={s.btnText}>{isSaving ? '⏹ 停止保存' : '💾 开始采集'}</Text>
        </TouchableOpacity>

        {isSaving && savePath ? (
          <Text style={s.savePath}>📂 {savePath}</Text>
        ) : null}

        {!isSaving && savePath ? (
          <TouchableOpacity
            style={s.exportBtn}
            onPress={exportSavedFile}>
            <Text style={s.btnText}>📤 导出数据文件</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* 日志 */}
      <View style={s.logBox}>
        <Text style={s.logHeader}>── 系统日志 ──</Text>
        {logs.map((l, i) => <Text key={i} style={s.logLine}>{l}</Text>)}
      </View>

    </ScrollView>
  );
}

// ── 样式 ─────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0F14' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 54, paddingBottom: 12
  },
  title: { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },
  batteryWrap: { alignItems: 'center', gap: 3 },
  batteryText: { color: '#aaa', fontSize: 12 },
  batteryBar: { height: 3, backgroundColor: '#00E676', borderRadius: 2 },

  sigCard: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 20,
    marginBottom: 14, borderWidth: 1.5, borderRadius: 12,
    paddingVertical: 10, paddingHorizontal: 14, gap: 10
  },
  sigDot: { width: 10, height: 10, borderRadius: 5 },
  horseshoe: { flexDirection: 'row', gap: 3 },
  hsDot: { width: 6, height: 6, borderRadius: 3 },
  sigLabel: { fontSize: 13, fontWeight: '700' },
  sigDesc: { fontSize: 11, color: '#666', marginTop: 2 },
  sigScore: { fontSize: 18, fontWeight: '800' },
  pktBadge: {
    fontSize: 10, color: '#555', backgroundColor: '#1A1D27',
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10
  },

  card: {
    marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
    borderRadius: 16, padding: 16
  },
  cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
  cardSub: { fontSize: 11, color: '#555', marginBottom: 10 },

  waveBox: { backgroundColor: '#0D0F14', borderRadius: 8, overflow: 'hidden' },

  modePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  modePillDense: { backgroundColor: '#1a3a4a' },
  modePillSparse: { backgroundColor: '#1a2e1a' },
  modePillText: { fontSize: 10, color: '#aaa', fontWeight: '600' },

  musicName: { fontSize: 13, color: '#aaa', textAlign: 'center', marginBottom: 14 },
  btnRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  btnPurple: { backgroundColor: '#8E44AD', paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10 },
  btnBlue: { backgroundColor: '#3498DB', paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10 },
  btnRed: { backgroundColor: '#E74C3C' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  timeText: { color: '#888', fontSize: 11, width: 34 },
  barTrack: { flex: 1, height: 4, backgroundColor: '#2A2D3A', borderRadius: 2, overflow: 'hidden' },
  barFill: { height: '100%', borderRadius: 2 },

  actionBtn: {
    backgroundColor: '#4A90E2', padding: 14, borderRadius: 12,
    alignItems: 'center', marginBottom: 10
  },
  clearBtn: { alignItems: 'center', paddingVertical: 8 },
  clearText: { color: '#FF6B6B', fontSize: 12 },

  sliderLabel: { fontSize: 12, color: '#aaa' },
  sliderHint: { fontSize: 11, color: '#555', lineHeight: 17, marginBottom: 10, marginTop: 3 },
  optRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  optBtn: {
    paddingHorizontal: 13, paddingVertical: 6, borderRadius: 20,
    backgroundColor: '#2A2D3A', borderWidth: 1, borderColor: '#444'
  },
  optBtnOn: { backgroundColor: '#3498DB', borderColor: '#3498DB' },
  optText: { color: '#aaa', fontSize: 12, fontWeight: '600' },

  modeBadge: { padding: 10, borderRadius: 8, marginBottom: 10 },
  modeBadgeDense: { backgroundColor: '#0d1f2d' },
  modeBadgeSparse: { backgroundColor: '#0d1f0d' },
  modeBadgeText: { color: '#aaa', fontSize: 12 },

  saveBtn: {
    backgroundColor: '#2A7DB5', paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', marginBottom: 8
  },
  saveBtnOn: { backgroundColor: '#E74C3C' },
  exportBtn: {
    backgroundColor: '#5D408B', paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', marginTop: 8
  },
  savePath: { fontSize: 11, color: '#555', textAlign: 'center' },

  logBox: { margin: 20, backgroundColor: '#0A0C11', borderRadius: 12, padding: 14 },
  logHeader: { color: '#444', fontSize: 11, textAlign: 'center', marginBottom: 8 },
  logLine: { fontSize: 11, color: '#00FF88', marginBottom: 4, fontFamily: 'monospace' },
});
