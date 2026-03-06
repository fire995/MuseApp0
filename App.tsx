import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Platform,
  PermissionsAndroid, TouchableOpacity, Dimensions,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, {
  Capability, AppKilledPlaybackBehavior, useProgress,
} from 'react-native-track-player';
import * as DocumentPicker from '@react-native-documents/picker';

if (!global.Buffer) { global.Buffer = Buffer; }

// ── 常量 ─────────────────────────────────────────────────────────
const bleManager = new BleManager();
const sleep      = (ms: number) => new Promise(r => setTimeout(r, ms));
const WS_URL     = 'ws://192.168.0.200:8001/ws/eeg';
const SCREEN_W   = Dimensions.get('window').width - 40;

const MUSE_SERVICE    = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL    = '273e0001-4c4d-454d-96be-f03bac821358';
const ATHENA_CHANNELS = ['273e0013','273e0014','273e0015','273e0016','273e0017']
  .map(id => `${id}-4c4d-454d-96be-f03bac821358`);
const PPG_CHANNELS    = ['273e0010','273e0011']
  .map(id => `${id}-4c4d-454d-96be-f03bac821358`);

// ── Muse BLE 命令（Base64）────────────────────────────────────────
// halt:      \x02h\n
// p1035:     \x06p1035\n  全速模式（EEG 256Hz + PPG，功耗高）
// p21:       \x04p21\n    低功耗模式（EEG 约 50Hz，无 PPG）
// dc001×2:   \x06dc001\n  启动数据流（必须发两次）
// status:    \x02s\n      心跳保活
const CMD_HALT       = 'AmgK';
const CMD_PRESET_HI  = 'BnAxMDM1Cg==';   // p1035 高速
const CMD_PRESET_LO  = 'BHAyMQo=';        // p21   低功耗
const CMD_START      = 'BmRjMDAxCg==';   // dc001
const CMD_STATUS     = 'AnMK';            // s（心跳）

// ── 类型 ─────────────────────────────────────────────────────────
type SignalLevel    = 'good' | 'ok' | 'poor' | 'none';
type SamplingMode   = 'dense' | 'sparse';

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
            left:  xs[i - 1] + dx / 2 - len / 2,
            top:   ys[i - 1] + dy / 2 - 1,
            width: len, height: 2,
            backgroundColor: '#00B894', borderRadius: 1,
            transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
          }} />
        );
      })}
    </View>
  );
});

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
  const [battery,       setBattery]       = useState<number | string>('--');
  const [signalLevel,   setSignalLevel]   = useState<SignalLevel>('none');
  const [signalScore,   setSignalScore]   = useState(0);
  const [electrodeQuality, setElectrodeQuality] = useState<Record<string, number>>({
    TP9: 0, AF7: 0, AF8: 0, TP10: 0
  });
  const [packetsRx,     setPacketsRx]     = useState(0);
  const [samplingMode,  setSamplingMode]  = useState<SamplingMode>('dense');
  const [savedDeviceId, setSavedDeviceId] = useState<string | null>(null);

  // 波形数据
  const [thetaWave, setThetaWave] = useState<number[]>([]);

  // 音乐
  const [isPlaying, setIsPlaying] = useState(false);
  const [musicName, setMusicName] = useState('未加载音乐');

  // 保存
  const [isSaving,  setIsSaving]  = useState(false);
  const [savePath,  setSavePath]  = useState('');
  const [denseMins, setDenseMins] = useState(30);

  // 日志
  const [logs, setLogs] = useState<string[]>([]);

  const ws              = useRef<WebSocket | null>(null);
  const deviceRef       = useRef<Device | null>(null);
  const isConnecting    = useRef(false);
  const isAutoRecon     = useRef(false);
  const userDisconnect  = useRef(false);  // 用户主动断开标志
  const heartbeat       = useRef<ReturnType<typeof setInterval> | null>(null);
  const samplingTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 信号平滑（10 帧中位数，彻底消除跳变）
  const signalBuf       = useRef<number[]>([]);

  const addLog = useCallback((msg: string) => {
    console.log(msg);
    setLogs(prev => [msg, ...prev].slice(0, 25));
  }, []);

  // ── 信号质量平滑（双层中位数：后端已做一次，前端再做一次）────
  const updateSignal = useCallback((raw: number) => {
    const buf = signalBuf.current;
    buf.push(raw);
    if (buf.length > 10) buf.shift();
    const sorted = [...buf].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)];
    setSignalScore(mid);
    setSignalLevel(mid >= 65 ? 'good' : mid >= 35 ? 'ok' : mid > 0 ? 'poor' : 'none');
  }, []);

  useEffect(() => {
    setupMusicPlayer();
    connectWebSocket();
    checkSavedDevice();
    return () => {
      ws.current?.close();
      if (heartbeat.current)    clearInterval(heartbeat.current);
      if (samplingTimer.current) clearTimeout(samplingTimer.current);
    };
  }, []);

  // ── WebSocket ────────────────────────────────────────────────
  const connectWebSocket = () => {
    const socket = new WebSocket(WS_URL);
    ws.current = socket;
    socket.onopen  = () => addLog('🟢 后端已连接');
    socket.onerror = () => addLog('🔴 后端连接失败，检查 IP / 后端是否启动');
    socket.onclose = () => addLog('🔴 WebSocket 已关闭');
    socket.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);

        if (msg.type === 'battery') {
          setBattery(msg.value);
        }

        if (msg.type === 'metrics') {
          updateSignal(msg.signal ?? 0);
          if (msg.electrode_quality) setElectrodeQuality(msg.electrode_quality);
          if (typeof msg.packets_rx === 'number') setPacketsRx(msg.packets_rx);
          // 困意高时自动降音量
          if ((msg.drowsiness ?? 0) > 75 && isPlaying) {
            const vol = await TrackPlayer.getVolume();
            if (vol > 0.1) await TrackPlayer.setVolume(Math.max(0.1, vol - 0.05));
          }
        }

        if (msg.type === 'theta_wave') {
          // 每次后端推来的都是最新 20 个点，直接拼接
          setThetaWave(prev => [...prev, ...(msg.data || [])].slice(-60));
        }

        if (msg.type === 'save_status') {
          setIsSaving(msg.saving);
          if (msg.path) setSavePath(msg.path);
          addLog(msg.saving ? `💾 保存中: ${msg.path}` : '⏹ 保存已停止');
        }
      } catch {}
    };
  };

  // ── 音乐 ─────────────────────────────────────────────────────
  const setupMusicPlayer = async () => {
    try {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification },
        capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      });
    } catch {}
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
      else           { await TrackPlayer.play();  setIsPlaying(true); }
    } catch {}
  };

  // ── 保存控制 ─────────────────────────────────────────────────
  const toggleSave = () => {
    if (ws.current?.readyState !== WebSocket.OPEN) {
      addLog('⚠️ 后端未连接，无法控制保存');
      return;
    }
    ws.current.send(JSON.stringify({
      type:          'settings',
      save_raw:      !isSaving,
      dense_minutes: denseMins,
    }));
  };

  // ── BLE 写命令 ────────────────────────────────────────────────
  const write = (device: Device, cmd: string) =>
    device.writeCharacteristicWithoutResponseForService(
      MUSE_SERVICE, MUSE_CONTROL, cmd
    ).catch(() => {});

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
    // 3. 通知后端
    ws.current?.readyState === WebSocket.OPEN &&
      ws.current.send(JSON.stringify({ type: 'sampling_mode', mode: 'sparse' }));
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

      device.monitorCharacteristicForService(MUSE_SERVICE, MUSE_CONTROL, (_, char) => {
        if (!char?.value) return;

        // 转发所有控制包给后端解析（包含电池和 Horseshoe 硬件阻抗）
        if (ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ channel: '0001', data: char.value }));
        }

        const txt = Buffer.from(char.value, 'base64').toString();
        ctrlBuf += txt;

        const bp = ctrlBuf.match(/"bp"\s*:\s*(\d+)/);
        if (bp) {
          setBattery(parseInt(bp[1]));
          ctrlBuf = ctrlBuf.replace(/"bp":\s*\d+/, '');
        }
        if (cmdResolve && ctrlBuf.includes('"rc":0')) {
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

      await sendCmd(CMD_HALT,      'halt');
      await sendCmd(CMD_PRESET_HI, 'preset p1035 高速模式');
      setSamplingMode('dense');

      addLog('🛡️ 订阅 EEG + PPG 通道…');
      [...ATHENA_CHANNELS, ...PPG_CHANNELS].forEach(uuid => {
        device.monitorCharacteristicForService(MUSE_SERVICE, uuid, (_, char) => {
          if (char?.value && ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({ channel: uuid.substring(4, 8), data: char.value }));
          }
        });
      });

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
    if (heartbeat.current)     { clearInterval(heartbeat.current);    heartbeat.current = null; }
    
    // 3. 取消自动重连
    isAutoRecon.current = false;
    
    // 4. 断开 BLE 连接
    try {
      if (deviceRef.current) {
        await deviceRef.current.cancelConnection();
        addLog('🔌 已断开头环 BLE 连接');
      }
    } catch {}
    
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
    good: { color: '#00E676', label: '信号良好 ✓',         desc: '采集质量优秀，数据可用于分析' },
    ok:   { color: '#FFCA28', label: '信号一般 — 调整头环', desc: '数据基本可用，建议调整佩戴' },
    poor: { color: '#FF5252', label: '信号差 — 重新佩戴',   desc: '建议取下重新佩戴后再试' },
    none: { color: '#555',    label: '未连接 / 等待数据',   desc: '' },
  }[signalLevel];

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

      {/* 信号状态 */}
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
  root:           { flex: 1, backgroundColor: '#0D0F14' },
  header:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                    paddingHorizontal: 20, paddingTop: 54, paddingBottom: 12 },
  title:          { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },
  batteryWrap:    { alignItems: 'center', gap: 3 },
  batteryText:    { color: '#aaa', fontSize: 12 },
  batteryBar:     { height: 3, backgroundColor: '#00E676', borderRadius: 2 },

  sigCard:        { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20,
                    marginBottom: 14, borderWidth: 1.5, borderRadius: 12,
                    paddingVertical: 10, paddingHorizontal: 14, gap: 10 },
  sigDot:         { width: 10, height: 10, borderRadius: 5 },
  horseshoe:      { flexDirection: 'row', gap: 3 },
  hsDot:          { width: 6, height: 6, borderRadius: 3 },
  sigLabel:       { fontSize: 13, fontWeight: '700' },
  sigDesc:        { fontSize: 11, color: '#666', marginTop: 2 },
  sigScore:       { fontSize: 18, fontWeight: '800' },
  pktBadge:       { fontSize: 10, color: '#555', backgroundColor: '#1A1D27',
                    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },

  card:           { marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
                    borderRadius: 16, padding: 16 },
  cardTitle:      { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
  cardSub:        { fontSize: 11, color: '#555', marginBottom: 10 },

  waveBox:        { backgroundColor: '#0D0F14', borderRadius: 8, overflow: 'hidden' },

  modePill:       { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
  modePillDense:  { backgroundColor: '#1a3a4a' },
  modePillSparse: { backgroundColor: '#1a2e1a' },
  modePillText:   { fontSize: 10, color: '#aaa', fontWeight: '600' },

  musicName:      { fontSize: 13, color: '#aaa', textAlign: 'center', marginBottom: 14 },
  btnRow:         { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  btnPurple:      { backgroundColor: '#8E44AD', paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10 },
  btnBlue:        { backgroundColor: '#3498DB', paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10 },
  btnRed:         { backgroundColor: '#E74C3C' },
  btnText:        { color: '#fff', fontWeight: '700', fontSize: 14 },
  timeText:       { color: '#888', fontSize: 11, width: 34 },
  barTrack:       { flex: 1, height: 4, backgroundColor: '#2A2D3A', borderRadius: 2, overflow: 'hidden' },
  barFill:        { height: '100%', borderRadius: 2 },

  actionBtn:      { backgroundColor: '#4A90E2', padding: 14, borderRadius: 12,
                    alignItems: 'center', marginBottom: 10 },
  clearBtn:       { alignItems: 'center', paddingVertical: 8 },
  clearText:      { color: '#FF6B6B', fontSize: 12 },

  sliderLabel:    { fontSize: 12, color: '#aaa' },
  sliderHint:     { fontSize: 11, color: '#555', lineHeight: 17, marginBottom: 10, marginTop: 3 },
  optRow:         { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  optBtn:         { paddingHorizontal: 13, paddingVertical: 6, borderRadius: 20,
                    backgroundColor: '#2A2D3A', borderWidth: 1, borderColor: '#444' },
  optBtnOn:       { backgroundColor: '#3498DB', borderColor: '#3498DB' },
  optText:        { color: '#aaa', fontSize: 12, fontWeight: '600' },

  modeBadge:      { padding: 10, borderRadius: 8, marginBottom: 10 },
  modeBadgeDense: { backgroundColor: '#0d1f2d' },
  modeBadgeSparse:{ backgroundColor: '#0d1f0d' },
  modeBadgeText:  { color: '#aaa', fontSize: 12 },

  saveBtn:        { backgroundColor: '#2A7DB5', paddingVertical: 12, borderRadius: 10,
                    alignItems: 'center', marginBottom: 8 },
  saveBtnOn:      { backgroundColor: '#E74C3C' },
  savePath:       { fontSize: 11, color: '#555', textAlign: 'center' },

  logBox:         { margin: 20, backgroundColor: '#0A0C11', borderRadius: 12, padding: 14 },
  logHeader:      { color: '#444', fontSize: 11, textAlign: 'center', marginBottom: 8 },
  logLine:        { fontSize: 11, color: '#00FF88', marginBottom: 4, fontFamily: 'monospace' },
});
