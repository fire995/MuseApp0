import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Platform,
  PermissionsAndroid, TouchableOpacity, Dimensions,
} from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, { Capability, AppKilledPlaybackBehavior, useProgress } from 'react-native-track-player';
import * as DocumentPicker from '@react-native-documents/picker';

if (!global.Buffer) { global.Buffer = Buffer; }

const bleManager = new BleManager();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const WS_URL    = 'ws://192.168.0.200:8001/ws/eeg';
const SCREEN_W  = Dimensions.get('window').width - 56;

const MUSE_SERVICE    = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL    = '273e0001-4c4d-454d-96be-f03bac821358';
const ATHENA_CHANNELS = ['273e0013', '273e0014', '273e0015', '273e0016', '273e0017']
  .map(id => `${id}-4c4d-454d-96be-f03bac821358`);
const PPG_CHANNELS = ['273e0010', '273e0011'] // 0010: Infrared, 0011: Red
  .map(id => `${id}-4c4d-454d-96be-f03bac821358`);

const BANDS = [
  { key: 'delta', label: 'Delta', range: '0.5–4Hz',  color: '#6C5CE7', note: '深睡' },
  { key: 'theta', label: 'Theta', range: '4–8Hz',    color: '#00B894', note: '困倦' },
  { key: 'alpha', label: 'Alpha', range: '8–13Hz',   color: '#0984E3', note: '放松' },
  { key: 'beta',  label: 'Beta',  range: '13–30Hz',  color: '#FDCB6E', note: '专注' },
  { key: 'gamma', label: 'Gamma', range: '30–50Hz',  color: '#FD79A8', note: '顿悟' },
];
type BandPowers = { delta: number; theta: number; alpha: number; beta: number; gamma: number };

// 隔离的进度条组件：避免音频的高频渲染导致整个 App 组件树重绘，这是 RN 性能优化的红线
const ProgressBar = () => {
  const { position, duration } = useProgress();
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };
  const pct = duration > 0 ? (position / duration) * 100 : 0;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 16, gap: 10 }}>
      <Text style={{ color: '#888', fontSize: 12, width: 36 }}>{formatTime(position)}</Text>
      <View style={{ flex: 1, height: 4, backgroundColor: '#2A2D3A', borderRadius: 2}}>
        <View style={{ height: '100%', width: `${pct}%`, backgroundColor: '#3498DB', borderRadius: 2}} />
      </View>
      <Text style={{ color: '#888', fontSize: 12, width: 36, textAlign: 'right' }}>{formatTime(duration)}</Text>
    </View>
  );
};

// ── 模拟数据 ──────────────────────────────────────────────────
let mockPhase = 0;
const generateMockData = () => {
  mockPhase += 0.04;
  const delta = Math.max(5, Math.min(95, 30 + Math.sin(mockPhase * 0.7) * 20 + Math.random() * 8));
  const theta = Math.max(5, Math.min(95, 45 + Math.sin(mockPhase + 1) * 25   + Math.random() * 8));
  const alpha = Math.max(5, Math.min(95, 55 + Math.sin(mockPhase * 1.3) * 20 + Math.random() * 8));
  const beta  = Math.max(5, Math.min(95, 35 + Math.sin(mockPhase * 0.5 + 2) * 15 + Math.random() * 8));
  const gamma = Math.max(5, Math.min(95, 25 + Math.sin(mockPhase * 0.3 + 1.5) * 10 + Math.random() * 8));
  const total = delta + theta + alpha + beta + gamma;
  return {
    bands: {
      delta: Math.round(delta / total * 100),
      theta: Math.round(theta / total * 100),
      alpha: Math.round(alpha / total * 100),
      beta:  Math.round(beta  / total * 100),
      gamma: Math.round(gamma / total * 100),
    },
    drowsiness: Math.max(0, Math.min(100, Math.round(50 + Math.sin(mockPhase * 0.4) * 35))),
    signal: 85 + Math.round(Math.random() * 12),
    // 注入模拟波峰：SpO2 锚定 95-100 健康区间，HRV 模拟 30-80ms 生理波动
    hrv: Math.round(45 + Math.sin(mockPhase * 0.8) * 15 + Math.random() * 10),
    spo2: Math.max(90, Math.min(100, Math.round(97 + Math.sin(mockPhase * 0.2) * 3))),
  };
};

const signalColor = (v: number | string) =>
  typeof v !== 'number' ? '#888' : v >= 70 ? '#00E676' : v >= 40 ? '#FFCA28' : '#FF5252';
const signalLabel = (v: number | string) =>
  typeof v !== 'number' ? '检测中…'
  : v >= 70 ? '信号良好'
  : v >= 40 ? '信号一般 – 调整头环'
  : '信号差 – 请重新佩戴';

export default function App() {
  const [logs,          setLogs]          = useState<string[]>([]);
  const [battery,       setBattery]       = useState<number | string>('--');
  const [signal,        setSignal]        = useState<number | string>('检测中...');
  const [drowsiness,    setDrowsiness]    = useState<number>(0);
  const [bandPowers,    setBandPowers]    = useState<BandPowers>({ delta:25, theta:25, alpha:25, beta:25, gamma:25 });
  const [drowHistory,   setDrowHistory]   = useState<number[]>(new Array(40).fill(0));
  const [hrv,           setHrv]           = useState<number | string>('--');
  const [spo2,          setSpo2]          = useState<number | string>('--');
  const [eegWave,       setEegWave]       = useState<number[]>(new Array(30).fill(0));
  const [isPlaying,     setIsPlaying]     = useState(false);
  const [musicName,     setMusicName]     = useState('未加载音乐');
  const [savedDeviceId, setSavedDeviceId] = useState<string | null>(null);
  const [mockMode,      setMockMode]      = useState(false);
  const [packetsRx,     setPacketsRx]     = useState(0);
  const [isSaving,      setIsSaving]      = useState(false);
  const [savePath,      setSavePath]      = useState('');

  const ws           = useRef<WebSocket | null>(null);
  const isConnecting = useRef(false);
  const isAutoRecon  = useRef(false);
  const deviceRef    = useRef<Device | null>(null);
  const heartbeat    = useRef<ReturnType<typeof setInterval> | null>(null);
  const mockTimer    = useRef<ReturnType<typeof setInterval> | null>(null);

  const log = (msg: string) => {
    console.log(msg);
    setLogs(prev => [msg, ...prev].slice(0, 30));
  };

  const pushDrowsiness = (d: number) => {
    setDrowsiness(d);
    setDrowHistory(prev => [...prev.slice(1), d]);
  };

  useEffect(() => {
    setupMusicPlayer();
    connectWebSocket();
    checkSavedDevice();
    return () => {
      ws.current?.close();
      if (heartbeat.current) clearInterval(heartbeat.current);
      if (mockTimer.current) clearInterval(mockTimer.current);
    };
  }, []);

  // ── 模拟数据 ───────────────────────────────────────────────
  const toggleMock = () => {
    if (mockMode) {
      setMockMode(false);
      if (mockTimer.current) { clearInterval(mockTimer.current); mockTimer.current = null; }
      log('⏹ 模拟模式已停止');
    } else {
      setMockMode(true);
      log('🧪 模拟模式已开启 – 仅供 UI 调试');
      mockTimer.current = setInterval(() => {
        const { bands, drowsiness: d, signal: s } = generateMockData();
        setBandPowers(bands);
        pushDrowsiness(d);
        setSignal(s);
      }, 500);
    }
  };

  // ── 原始数据保存开关 ────────────────────────────────────────
  const toggleSave = () => {
    const newState = !isSaving;
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'settings', save_raw: newState }));
      log(newState ? '💾 已请求开启原始数据保存' : '⏹ 已请求停止保存');
    } else {
      log('⚠️ 后端未连接，无法切换保存状态');
    }
  };

  // ── 音乐播放器 ──────────────────────────────────────────────
  const setupMusicPlayer = async () => {
    try {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification },
        capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
        compactCapabilities: [Capability.Play, Capability.Pause],
      });
      log('✅ 音频引擎初始化成功');
    } catch { log('音频引擎已就绪'); }
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
        log(`▶️ 开始播放: ${res.name}`);
      }
    } catch (err) { if (!DocumentPicker.isCancel(err)) log(`❌ 选择音乐失败: ${err}`); }
  };

  const togglePlay = async () => {
    try {
      if (isPlaying) { await TrackPlayer.pause(); setIsPlaying(false); log('⏸️ 音乐已暂停'); }
      else           { await TrackPlayer.play();  setIsPlaying(true);  log('▶️ 音乐继续播放'); }
    } catch (e) { log(`❌ 播放控制失败: ${e}`); }
  };

  // ── WebSocket ───────────────────────────────────────────────
  const connectWebSocket = () => {
    ws.current = new WebSocket(WS_URL);
    ws.current.onopen  = () => log('🟢 已连接 Python 后端');
    ws.current.onerror = () => log('🔴 后端连接失败，请检查 IP');
    ws.current.onclose = () => log('🔴 WebSocket 已关闭');
    ws.current.onmessage = async (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'battery') {
          setBattery(msg.value);
        }
        if (msg.type === 'metrics') {
          setSignal(msg.signal);
          pushDrowsiness(msg.drowsiness);
          if (msg.bands) setBandPowers(msg.bands);
          if (typeof msg.packets_rx === 'number') setPacketsRx(msg.packets_rx);
          // 拦截解析后端下发的多模态指标
          if (typeof msg.hrv === 'number') setHrv(msg.hrv);
          if (typeof msg.spo2 === 'number') setSpo2(msg.spo2);
          // 困意 > 75 时自动降低音量
          if (msg.drowsiness > 75 && isPlaying) {
            const vol = await TrackPlayer.getVolume();
            if (vol > 0) await TrackPlayer.setVolume(Math.max(0, vol - 0.05));
          }
        }
        if (msg.type === 'eeg_preview') {
          setEegWave(prev => [...prev, ...(msg.data || [])].slice(-60));
        }
        if (msg.type === 'data_status') {
          setPacketsRx(msg.packets || 0);
        }
        if (msg.type === 'save_status') {
          setIsSaving(msg.saving);
          if (msg.path) setSavePath(msg.path);
          log(msg.saving ? `💾 正在保存: ${msg.path}` : '⏹ 保存已停止');
        }
      } catch {}
    };
  };

  // ─────────────────────────────────────────────────────────────
  //  Muse BLE 协议（amused-py 逆向工程成果）
  //
  //  关键设计：只建立【一个】MUSE_CONTROL 持久监听器，同时处理:
  //    - 命令应答（"rc":0）
  //    - 电池通知（"bp":XX）
  //  避免 react-native-ble-plx 对同一特征值多次订阅冲突
  //
  //  正确启动序列:
  //    1. halt       AmgK           → \x02h\n
  //    2. preset     BnAxMDM1Cg==  → \x06p1035\n  全传感器模式
  //    3. 订阅 EEG 数据通道（0013-0017）
  //    4. dc001 × 2  BmRjMDAxCg==  → \x06dc001\n  ⚠️ 必须发两次！
  //    5. 心跳       AnMK           → \x02s\n      每 30 秒保活
  // ─────────────────────────────────────────────────────────────
  const write = (device: Device, cmd: string) =>
    device.writeCharacteristicWithoutResponseForService(
      MUSE_SERVICE, MUSE_CONTROL, cmd
    ).catch(() => {});

  const startMuseProtocol = async (device: Device) => {
    try {
      device.onDisconnected(() => {
        log('⚠️ 设备断开，重连中...');
        if (!isAutoRecon.current) {
          isAutoRecon.current = true;
          reconnectLoop(device);
        }
      });

      // ── 建立唯一的 MUSE_CONTROL 持久监听器 ──────────────
      let cmdResolve: (() => void) | null = null;
      let ctrlBuf = '';

      device.monitorCharacteristicForService(MUSE_SERVICE, MUSE_CONTROL, (err, char) => {
        if (!char?.value) return;
        const txt = Buffer.from(char.value, 'base64').toString();
        ctrlBuf += txt;

        // 电池通知（定期推送）
        const bpMatch = ctrlBuf.match(/"bp":\s*(\d+)/);
        if (bpMatch) {
          const bv = parseInt(bpMatch[1]);
          setBattery(bv);
          // 同步发给后端
          if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current!.send(JSON.stringify({ channel: '0001', data: char.value }));
          }
          ctrlBuf = ctrlBuf.replace(/"bp":\s*\d+/, '');
        }

        // 命令应答
        if (cmdResolve && ctrlBuf.includes('"rc":0')) {
          cmdResolve();
          cmdResolve = null;
          ctrlBuf = ctrlBuf.replace(/"rc":0/, '');
        }

        // 防止缓冲区溢出
        if (ctrlBuf.length > 500) ctrlBuf = ctrlBuf.slice(-200);
      });

      // 带超时的命令发送（等待 rc:0 或 2s 超时）
      const sendCmd = (b64: string, label: string): Promise<void> =>
        new Promise(resolve => {
          cmdResolve = resolve;
          write(device, b64);
          setTimeout(() => { if (cmdResolve) { cmdResolve = null; resolve(); } }, 2000);
          log(`🔧 ${label}...`);
        });

      // ── 启动序列 ──────────────────────────────────────────
      await sendCmd('AmgK',          'halt');
      await sendCmd('BnAxMDM1Cg==',  'preset p1035');

      // ── 订阅多模态数据通道 (EEG + PPG)
      log('🛡️ 订阅 EEG 与 PPG 传感通道...');
      [...ATHENA_CHANNELS, ...PPG_CHANNELS].forEach(uuid => {
        device.monitorCharacteristicForService(MUSE_SERVICE, uuid, (err, char) => {
          if (char?.value && ws.current?.readyState === WebSocket.OPEN) {
            ws.current!.send(JSON.stringify({
              channel: uuid.substring(4, 8),
              data:    char.value,
            }));
          }
        });
      });

      // ── dc001 × 2（关键！必须发两次才能触发数据流）─────
      log('🔧 dc001 × 2（启动数据流）...');
      await write(device, 'BmRjMDAxCg==');   // 第一次
      await sleep(150);
      await write(device, 'BmRjMDAxCg==');   // 第二次 ✅

      log('🏁 数据流已启动');

      // ── 心跳保活 ──────────────────────────────────────────
      if (heartbeat.current) clearInterval(heartbeat.current);
      setTimeout(() => write(device, 'AnMK'), 2000);
      heartbeat.current = setInterval(() => write(device, 'AnMK'), 30000);

    } catch (e: any) { log(`❌ 协议失败: ${e.message}`); }
  };

  const reconnectLoop = async (device: Device) => {
    while (true) {
      try {
        const d = await device.connect();
        await sleep(500);
        await d.discoverAllServicesAndCharacteristics();
        await startMuseProtocol(d);
        isAutoRecon.current = false;
        log('✅ 重连成功');
        break;
      } catch { await sleep(3000); }
    }
  };

  const scanAndConnect = async () => {
    if (isConnecting.current) return;
    isConnecting.current = true;
    const state = await bleManager.state();
    if (state !== 'PoweredOn') { log('❌ 蓝牙未开启'); isConnecting.current = false; return; }
    if (Platform.OS === 'android') {
      const g = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      if (g['android.permission.BLUETOOTH_SCAN'] !== PermissionsAndroid.RESULTS.GRANTED) {
        log('❌ 缺少蓝牙权限'); isConnecting.current = false; return;
      }
    }
    log('📡 扫描中...');
    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) { log(`扫描错误: ${error.message}`); isConnecting.current = false; return; }
      if (device?.name?.includes('Muse')) {
        bleManager.stopDeviceScan();
        try {
          log(`🔗 发现 ${device.name}，连接中...`);
          const d = await device.connect();
          await AsyncStorage.setItem('MUSE_DEVICE_ID', d.id);
          setSavedDeviceId(d.id);
          await sleep(500);
          await d.discoverAllServicesAndCharacteristics();
          log('✅ BLE 握手完成');
          deviceRef.current = d;
          await startMuseProtocol(d);
        } catch (e: any) { log(`❌ 连接失败: ${e.message}`); isConnecting.current = false; }
      }
    });
    setTimeout(() => { bleManager.stopDeviceScan(); isConnecting.current = false; }, 10000);
  };

  const checkSavedDevice  = async () => { const id = await AsyncStorage.getItem('MUSE_DEVICE_ID'); if (id) setSavedDeviceId(id); };
  const clearPairedDevice = async () => { await AsyncStorage.removeItem('MUSE_DEVICE_ID'); setSavedDeviceId(null); log('🗑️ 已清除绑定记录'); };

  // ── EEG 原始波形 ────────────────────────────────────────────
  const EEGWaveform = () => {
    const W = SCREEN_W, H = 52, pad = 4;
    if (eegWave.every(v => v === 0)) return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>〜 EEG 原始波形</Text>
        <View style={{ height: H, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: '#444', fontSize: 12 }}>等待数据...</Text>
        </View>
      </View>
    );
    const pts = eegWave.slice(-50);
    const mn  = Math.min(...pts), mx = Math.max(...pts);
    const range = mx - mn || 1;
    const xs = pts.map((_, i) => pad + (i / (pts.length - 1)) * (W - pad * 2));
    const ys = pts.map(v => H - pad - ((v - mn) / range) * (H - pad * 2));
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>〜 EEG 原始波形（TP9）</Text>
        <View style={{ height: H, width: W }}>
          {xs.map((x, i) => {
            if (i === 0) return null;
            // 弃用 transformOrigin 方案，使用中心点偏移绝对定位，确保在所有 RN 版本下线条不发生偏移截断
            const dx = x - xs[i - 1];
            const dy = ys[i] - ys[i - 1];
            const length = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);
            const cx = xs[i - 1] + dx / 2;
            const cy = ys[i - 1] + dy / 2;
            
            return (
              <View key={i} style={{
                position: 'absolute', 
                left: cx - length / 2, 
                top: cy - 1,
                width: length,
                height: 2, 
                backgroundColor: '#00B894', 
                borderRadius: 1,
                transform: [{ rotate: `${angle}rad` }],
              }} />
            );
          })}
        </View>
      </View>
    );
  };

  // ── 困意趋势图 ──────────────────────────────────────────────
  const DrowsinessChart = () => {
    const W = SCREEN_W, H = 64, pad = 4;
    const xs = drowHistory.map((_, i) => pad + (i / (drowHistory.length - 1)) * (W - pad * 2));
    const ys = drowHistory.map(v => H - pad - (v / 100) * (H - pad * 2));
    return (
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>📈 困意趋势（近 20 秒）</Text>
        <View style={{ height: H, width: W }}>
          {[0, 25, 50, 75, 100].map(v => (
            <View key={v} style={[styles.gridLine, { top: H - pad - (v / 100) * (H - pad * 2) }]}>
              <Text style={styles.gridLabel}>{v}</Text>
            </View>
          ))}
          {xs.map((x, i) => i === 0 ? null : (
            <View key={i} style={{
              position: 'absolute', left: xs[i - 1], top: Math.min(ys[i - 1], ys[i]) - 1,
              width: Math.sqrt(Math.pow(x - xs[i-1], 2) + Math.pow(ys[i] - ys[i-1], 2)),
              height: 2.5, backgroundColor: '#E17055', borderRadius: 1,
              transform: [{ rotate: `${Math.atan2(ys[i] - ys[i-1], x - xs[i-1]) * 180 / Math.PI}deg` }],
              transformOrigin: '0 50%',
            }} />
          ))}
          <View style={{
            position: 'absolute', left: xs[xs.length - 1] - 5, top: ys[ys.length - 1] - 5,
            width: 10, height: 10, borderRadius: 5, backgroundColor: '#E17055',
            borderWidth: 2, borderColor: '#fff',
          }} />
        </View>
      </View>
    );
  };

  // ── 频段功率条 ──────────────────────────────────────────────
  const BandBars = () => (
    <View style={styles.card}>
      <Text style={styles.sectionTitle}>🧠 脑波频段功率</Text>
      {BANDS.map(b => {
        const val = bandPowers[b.key as keyof BandPowers];
        return (
          <View key={b.key} style={styles.bandRow}>
            <View style={styles.bandLabelWrap}>
              <Text style={[styles.bandLabel, { color: b.color }]}>{b.label}</Text>
              <Text style={styles.bandSub}>{b.range}</Text>
            </View>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${val}%`, backgroundColor: b.color }]} />
            </View>
            <View style={styles.bandRightWrap}>
              <Text style={[styles.bandPct, { color: b.color }]}>{val}%</Text>
              <Text style={styles.bandNote}>{b.note}</Text>
            </View>
          </View>
        );
      })}
    </View>
  );

  // ── 渲染 ────────────────────────────────────────────────────
  const sigColor = signalColor(signal);
  const topBand  = BANDS.reduce((a, b) =>
    bandPowers[b.key as keyof BandPowers] > bandPowers[a.key as keyof BandPowers] ? b : a
  );

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: 40 }}>

      {/* 顶栏 */}
      <View style={styles.header}>
        <Text style={styles.title}>BCI 冥想平台</Text>
        <View style={styles.headerRight}>
          {/* 架构调整：移除强类型拦截，允许在未连接时展示默认占位符，修复"电量不显示"问题 */}
          <View style={styles.batteryWrap}>
            <Text style={styles.batteryText}>
              🔋 {battery}{typeof battery === 'number' ? '%' : ''}
            </Text>
            {typeof battery === 'number' && (
              <View style={[styles.batteryBar, { width: Math.max(0, Math.min(100, battery)) * 0.28 }]} />
            )}
          </View>
          <TouchableOpacity
            style={[styles.mockBtn, mockMode && styles.mockBtnOn]}
            onPress={toggleMock}>
            <Text style={styles.mockBtnText}>{mockMode ? '⏹ 停止模拟' : '🧪 模拟'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* 信号状态栏 */}
      <View style={[styles.signalBadge, { borderColor: sigColor }]}>
        <View style={[styles.signalDot, { backgroundColor: sigColor }]} />
        <Text style={[styles.signalText, { color: sigColor }]}>{signalLabel(signal)}</Text>
        {typeof signal === 'number' && (
          <Text style={[styles.signalPct, { color: sigColor }]}>{signal}%</Text>
        )}
        {packetsRx > 0 && (
          <Text style={styles.packetBadge}>
            {packetsRx < 1000 ? `${packetsRx}包` : `${(packetsRx / 1000).toFixed(1)}k包`}
          </Text>
        )}
      </View>

      {/* 架构调整 1：将音乐播放板块前置至信号栏下方，突出核心反馈业务 */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>🎵 冥想音乐</Text>
        <Text style={styles.musicText}>{musicName}</Text>
        <View style={styles.btnGroup}>
          <TouchableOpacity style={styles.btnPurple} onPress={pickAndPlay}>
            <Text style={styles.btnText}>选择音频</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btnBlue, isPlaying && styles.btnRed]}
            onPress={togglePlay}>
            <Text style={styles.btnText}>{isPlaying ? '⏸️ 暂停' : '▶️ 播放'}</Text>
          </TouchableOpacity>
        </View>
        <ProgressBar />
      </View>

      {/* 主仪表盘 (保留之前的 2x2 网格) */}
      <View style={styles.dashboard}>
        <View style={styles.dashRow}>
          <View style={styles.dashItem}>
            <Text style={styles.dashLabel}>困意指数</Text>
            <Text style={[styles.dashValue, { color: drowsiness > 70 ? '#FF5252' : drowsiness > 40 ? '#FFCA28' : '#00E676' }]}>
              {drowsiness}%
            </Text>
            <Text style={styles.dashSub}>{drowsiness > 70 ? '⚠️ 疲劳' : drowsiness > 40 ? '😑 注意' : '😊 清醒'}</Text>
          </View>
          <View style={styles.dashDivider} />
          <View style={styles.dashItem}>
            <Text style={styles.dashLabel}>主导波段</Text>
            <Text style={[styles.dashValue, { color: topBand.color }]}>{topBand.label}</Text>
            <Text style={styles.dashSub}>{topBand.note} · {topBand.range}</Text>
          </View>
        </View>
        <View style={styles.dashHDivider} />
        <View style={styles.dashRow}>
          <View style={styles.dashItem}>
            <Text style={styles.dashLabel}>HRV (心率变异性)</Text>
            <Text style={[styles.dashValue, { color: typeof hrv === 'number' && hrv < 30 ? '#FFCA28' : '#3498DB' }]}>
              {hrv}<Text style={styles.dashUnit}>ms</Text>
            </Text>
            <Text style={styles.dashSub}>副交感神经评估</Text>
          </View>
          <View style={styles.dashDivider} />
          <View style={styles.dashItem}>
            <Text style={styles.dashLabel}>血氧饱和度</Text>
            <Text style={[styles.dashValue, { color: typeof spo2 === 'number' && spo2 < 95 ? (spo2 < 90 ? '#FF5252' : '#FFCA28') : '#00E676' }]}>
              {spo2}<Text style={styles.dashUnit}>%</Text>
            </Text>
            <Text style={styles.dashSub}>{typeof spo2 === 'number' && spo2 < 95 ? '⚠️ 异常区间' : '供氧充足'}</Text>
          </View>
        </View>
      </View>

      <EEGWaveform />
      <DrowsinessChart />
      <BandBars />

      {/* 架构调整 2：设备连接管理紧贴底层控制与调试数据 */}
      <TouchableOpacity style={styles.actionBtn} onPress={scanAndConnect}>
        <Text style={styles.btnText}>📡 扫描并连接 Muse 头环</Text>
      </TouchableOpacity>
      {savedDeviceId && (
        <TouchableOpacity style={styles.clearBtn} onPress={clearPairedDevice}>
          <Text style={styles.clearBtnText}>🗑️ 清除配对: {savedDeviceId.substring(0, 10)}…</Text>
        </TouchableOpacity>
      )}

      {/* 架构调整 3：原始数据保存作为工程化调试选项置底 */}
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>💾 原始数据保存</Text>
        <Text style={styles.saveDesc}>
          {isSaving
            ? `保存中... 📂 ${savePath || 'sleep_logs/raw_eeg_*.csv'}`
            : '关闭 – 点击下方开关启用保存'}
        </Text>
        <TouchableOpacity
          style={[styles.saveToggle, isSaving && styles.saveToggleOn]}
          onPress={toggleSave}>
          <Text style={styles.btnText}>{isSaving ? '⏹ 停止保存' : '💾 开始保存 EEG'}</Text>
        </TouchableOpacity>
        {isSaving && (
          <Text style={styles.saveNote}>
            每次会话独立文件，包含时间戳 · 通道 · 样本序号 · µV 值
          </Text>
        )}
      </View>

      {/* 日志 */}
      <View style={styles.logBox}>
        <Text style={styles.logHeader}>── 系统日志 ──</Text>
        {logs.map((l, i) => <Text key={i} style={styles.logText}>{l}</Text>)}
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root:          { flex: 1, backgroundColor: '#0D0F14' },
  header:        { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, paddingTop: 54 },
  headerRight:   { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title:         { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },
  batteryWrap:   { alignItems: 'center', gap: 3 },
  batteryText:   { color: '#aaa', fontSize: 12 },
  batteryBar:    { height: 3, backgroundColor: '#00E676', borderRadius: 2 },
  mockBtn:       { backgroundColor: '#2A2D3A', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: '#444' },
  mockBtnOn:     { backgroundColor: '#00B894', borderColor: '#00B894' },
  mockBtnText:   { color: '#fff', fontSize: 12, fontWeight: '600' },
  signalBadge:   { flexDirection: 'row', alignItems: 'center', marginHorizontal: 20, marginBottom: 14, borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, gap: 8 },
  signalDot:     { width: 9, height: 9, borderRadius: 5 },
  signalText:    { fontSize: 13, fontWeight: '600', flex: 1 },
  signalPct:     { fontSize: 13, fontWeight: '700' },
  packetBadge:   { fontSize: 10, color: '#555', backgroundColor: '#1A1D27', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10 },
  dashboard:     { marginHorizontal: 20, marginBottom: 16, backgroundColor: '#1A1D27', borderRadius: 16, overflow: 'hidden' },
  dashRow:       { flexDirection: 'row' },
  dashItem:      { flex: 1, padding: 16, alignItems: 'center', justifyContent: 'center' },
  dashDivider:   { width: 1, backgroundColor: '#2A2D3A', marginVertical: 16 },
  dashHDivider:  { height: 1, backgroundColor: '#2A2D3A', marginHorizontal: 16 },
  dashLabel:     { fontSize: 11, color: '#888', marginBottom: 4 },
  dashValue:     { fontSize: 28, fontWeight: '800' },
  dashUnit:      { fontSize: 14, fontWeight: '600', color: '#666' },
  dashSub:       { fontSize: 10, color: '#666', marginTop: 2 },
  card:          { marginHorizontal: 20, marginBottom: 16, backgroundColor: '#1A1D27', borderRadius: 16, padding: 16 },
  sectionTitle:  { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 14 },
  gridLine:      { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#2A2D3A' },
  gridLabel:     { position: 'absolute', right: 0, top: -8, fontSize: 9, color: '#444' },
  bandRow:       { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  bandLabelWrap: { width: 52 },
  bandLabel:     { fontSize: 13, fontWeight: '700' },
  bandSub:       { fontSize: 9, color: '#555' },
  barTrack:      { flex: 1, height: 8, backgroundColor: '#2A2D3A', borderRadius: 4, marginHorizontal: 10, overflow: 'hidden' },
  barFill:       { height: 8, borderRadius: 4 },
  bandRightWrap: { width: 52, alignItems: 'flex-end' },
  bandPct:       { fontSize: 13, fontWeight: '700' },
  bandNote:      { fontSize: 9, color: '#555' },
  saveDesc:      { fontSize: 12, color: '#777', marginBottom: 12, lineHeight: 18 },
  saveToggle:    { backgroundColor: '#2A7DB5', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10, alignItems: 'center', marginBottom: 8 },
  saveToggleOn:  { backgroundColor: '#E74C3C' },
  saveNote:      { fontSize: 11, color: '#555', textAlign: 'center', marginTop: 4 },
  musicText:     { fontSize: 14, color: '#aaa', marginBottom: 16, textAlign: 'center' },
  btnGroup:      { flexDirection: 'row', justifyContent: 'center', gap: 12 },
  btnPurple:     { backgroundColor: '#8E44AD', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
  btnBlue:       { backgroundColor: '#3498DB', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
  btnRed:        { backgroundColor: '#E74C3C' },
  btnText:       { color: '#fff', fontWeight: '700', fontSize: 14 },
  actionBtn:     { backgroundColor: '#4A90E2', marginHorizontal: 20, padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 10 },
  clearBtn:      { alignItems: 'center', paddingVertical: 8 },
  clearBtnText:  { color: '#FF6B6B', fontSize: 12 },
  logBox:        { margin: 20, backgroundColor: '#0A0C11', borderRadius: 12, padding: 14 },
  logHeader:     { color: '#444', fontSize: 11, textAlign: 'center', marginBottom: 8 },
  logText:       { fontSize: 11, color: '#00FF88', marginBottom: 5, fontFamily: 'monospace' },
});
