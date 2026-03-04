import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Button, ScrollView, StyleSheet, Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, { Capability, useProgress, State } from 'react-native-track-player';
import DocumentPicker from 'react-native-document-picker';

if (!global.Buffer) { global.Buffer = Buffer; }
const bleManager = new BleManager();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ⚠️ 请修改为你电脑的真实 IP
const WS_URL = 'ws://192.168.0.200:8001/ws/eeg'; 

const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL = '273e0001-4c4d-454d-96be-f03bac821358';
const ATHENA_CHANNELS = ['273e0013', '273e0014', '273e0015'].map(id => `${id}-4c4d-454d-96be-f03bac821358`);

export default function App() {
  const [status, setStatus] = useState('等待操作...');
  const [logs, setLogs] = useState<string[]>([]);
  
  const [battery, setBattery] = useState<number | string>('读取中...');
  const [signal, setSignal] = useState<number | string>('检测中...');
  const [drowsiness, setDrowsiness] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [musicName, setMusicName] = useState('未加载音乐');
  const [savedDeviceId, setSavedDeviceId] = useState<string | null>(null);
  const progress = useProgress();
  
  const ws = useRef<WebSocket | null>(null);
  const isConnecting = useRef(false);
  const isAutoReconnecting = useRef(false);
  const deviceRef = useRef<Device | null>(null);

  const log = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 15));
    setStatus(msg);
  };

  useEffect(() => {
    setupMusicPlayer();
    connectWebSocket();
    checkSavedDevice(); // 尝试无感直连
    
    const bleSub = bleManager.onStateChange(async (state) => {
      if (state === 'PoweredOn') {
        const id = await AsyncStorage.getItem('MUSE_DEVICE_ID');
        if (id) {
          setSavedDeviceId(id);
          log('🔄 发现历史配对记录，尝试静默直连...');
          autoConnect(id);
        }
      }
    }, true);

    return () => { 
      TrackPlayer.destroy();
      ws.current?.close(); 
      bleSub?.remove();
    };
  }, []);

  // --- 音乐播放逻辑 ---
  const setupMusicPlayer = async () => {
    try {
      await TrackPlayer.setupPlayer();
      await TrackPlayer.updateOptions({
        capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
      });
    } catch (e) {}
  };

  const pickAndPlay = async () => {
    try {
      const res = await DocumentPicker.pickSingle({ type: [DocumentPicker.types.audio] });
      await TrackPlayer.reset();
      await TrackPlayer.add({ id: 'meditation', url: res.uri, title: res.name || '冥想音乐' });
      setMusicName(res.name || '已加载');
    } catch (err) {}
  };

  const togglePlay = async () => {
    const state = await TrackPlayer.getState();
    if (state === State.Playing) {
      await TrackPlayer.pause();
      setIsPlaying(false);
    } else {
      await TrackPlayer.play();
      setIsPlaying(true);
    }
  };

  // --- 自动重连与直连逻辑 ---
  const checkSavedDevice = async () => {
    const id = await AsyncStorage.getItem('MUSE_DEVICE_ID');
    if (id) {
      console.log('🔄 尝试自动直连上次设备:', id);
      try {
        const dev = await bleManager.connectToDevice(id);
        await dev.discoverAllServicesAndCharacteristics();
        startMuseProtocol(dev);
      } catch (e) {
        log('自动直连失败，需手动连接');
      }
    }
  };

  const autoConnect = async (deviceId: string) => {
    if (isConnecting.current) return;
    isConnecting.current = true;
    
    try {
      // 尝试直接物理连接已知 ID，跳过宽泛扫描
      const connectedDevice = await bleManager.connectToDevice(deviceId);
      await sleep(500);
      log('✅ 历史设备物理直连成功');
      
      await connectedDevice.discoverAllServicesAndCharacteristics();
      deviceRef.current = connectedDevice;
      await startMuseProtocol(connectedDevice);
    } catch (e: any) {
      log(`⚠️ 直连失败，设备可能未开机或不在附近。`);
      isConnecting.current = false;
    }
  };

  const connectWebSocket = () => {
    ws.current = new WebSocket(WS_URL);
    ws.current.onopen = () => log('🟢 成功连接 FastAPI 后端');
    ws.current.onerror = () => log(`🔴 后端连接失败`);
    ws.current.onclose = () => log(`🔴 WebSocket连接已关闭`);
    
    ws.current.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'battery') setBattery(msg.value);
      if (msg.type === 'metrics') {
        setSignal(msg.signal);
        setDrowsiness(msg.drowsiness);
        // 核心功能：困意高则降音量
        if (msg.drowsiness > 75 && isPlaying) {
          const vol = await TrackPlayer.getVolume();
          await TrackPlayer.setVolume(Math.max(0, vol - 0.05));
        }
      }
      if (msg.type === 'eeg_preview') {
        // 保留波形显示逻辑
      }
    };
  };

  const getSignalStatus = (val: number | string) => {
    if (typeof val !== 'number') return { text: val, color: '#888', icon: '⚪' };
    if (val >= 80) return { text: `${val}% (极佳)`, color: '#00E676', icon: '🟢' };
    if (val >= 40) return { text: `${val}% (一般)`, color: '#FFCA28', icon: '🟡' };
    return { text: `${val}% (差)`, color: '#F44336', icon: '🔴' };
  };

  const sendCommand = async (device: Device, base64: string, name: string) => {
    return new Promise<void>(async (resolve) => {
      let resolved = false;
      let buffer = "";
      const sub = device.monitorCharacteristicForService(MUSE_SERVICE, MUSE_CONTROL, (err, char) => {
        if (err || resolved) return;
        if (char?.value) {
          buffer += Buffer.from(char.value, 'base64').toString();
          if (buffer.includes('}') && buffer.includes('"rc":0')) {
            log(`✅ ${name} 成功`);
            resolved = true; 
            sub.remove(); 
            resolve();
          }
        }
      });
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, base64);
      setTimeout(() => { if (!resolved) { sub.remove(); resolve(); } }, 2000);
    });
  };

  const startMuseProtocol = async (device: Device) => {
    try {
      // 监听断连事件，实现自动重连
      device.onDisconnected((error, disconnectedDevice) => {
        log('⚠️ 设备异常断开，正在尝试静默重连...');
        if (!isAutoReconnecting.current) {
          isAutoReconnecting.current = true;
          reconnectLoop(disconnectedDevice);
        }
      });

      log('🛡️ 启动协议序列...');
      [MUSE_CONTROL, ...ATHENA_CHANNELS].forEach(uuid => {
        device.monitorCharacteristicForService(MUSE_SERVICE, uuid, (err, char) => {
          if (char?.value && ws.current?.readyState === 1) {
            ws.current!.send(JSON.stringify({ channel: uuid.substring(4,8), data: char.value }));
          }
        });
      });

      await sendCommand(device, 'A3YxCg==', 'Version (v1)');
      await sendCommand(device, 'AmgK', 'Halt (h)');
      await sendCommand(device, 'BnAxMDM1Cg==', 'Preset (p1035)');

      log('🚀 发送激活脉冲...');
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'BmRjMDAxCg==');
      await sleep(100);
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'A0wxCg==');
      await sleep(200);
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'BmRjMDAxCg==');
      
      log('🏁 序列完成，启动心跳守护...');
      setTimeout(() => {
        device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'AnMK').catch(() => {});
      }, 2000);
      setInterval(() => {
        device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'AnMK').catch(() => {});
      }, 30000);

    } catch (e: any) { 
      log(`❌ 协议初始化失败: ${e.message}`); 
    }
  };

  const reconnectLoop = async (device: Device) => {
    let connected = false;
    while (!connected) {
      try {
        log('🔄 重新扫描并尝试物理连接...');
        const newDevice = await device.connect();
        await sleep(500);
        await newDevice.discoverAllServicesAndCharacteristics();
        await startMuseProtocol(newDevice);
        connected = true;
        isAutoReconnecting.current = false;
        log('✅ 重连成功，恢复监测');
      } catch (e) {
        log('重连尝试失败，3秒后重试...');
        await sleep(3000); // 3秒重试一次
      }
    }
  };

  const scanAndConnect = async () => {
    if (isConnecting.current) return;
    isConnecting.current = true;
    
    const state = await bleManager.state();
    if (state !== 'PoweredOn') { 
      log('蓝牙未开启'); 
      isConnecting.current = false; 
      return; 
    }
    
    const hasPermission = await requestBluetoothPermission();
    if (!hasPermission) { 
      isConnecting.current = false; 
      return; 
    }
    
    log('正在进行全局扫描...');
    bleManager.startDeviceScan(null, null, async (error, device) => {
      if (error) { 
        log(`扫描错误: ${error.message}`); 
        isConnecting.current = false; 
        return; 
      }
      if (device?.name?.includes('Muse')) {
        bleManager.stopDeviceScan();
        try {
          log('建立物理连接...');
          const connectedDevice = await device.connect();
          
          // 保存成功连接的设备 ID
          await AsyncStorage.setItem('MUSE_DEVICE_ID', connectedDevice.id);
          setSavedDeviceId(connectedDevice.id);
          
          await sleep(500);
          await connectedDevice.discoverAllServicesAndCharacteristics();
          log('✅ 服务发现完成');
          deviceRef.current = connectedDevice;
          await startMuseProtocol(connectedDevice);
        } catch (e: any) { 
          log(`连接失败: ${e.message}`); 
          isConnecting.current = false; 
        }
      }
    });
  };

  // 清除配对设备功能
  const clearPairedDevice = async () => {
    await AsyncStorage.removeItem('MUSE_DEVICE_ID');
    setSavedDeviceId(null);
    log('🗑️ 已清除历史设备绑定记录，下次需手动扫描');
  };

  const requestBluetoothPermission = async () => {
    if (Platform.OS === 'android' && Platform.Version >= 31) {
      const granted = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      ]);
      return granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED;
    }
    return true;
  };

  const sigStatus = getSignalStatus(signal);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>BCI 冥想播放器</Text>
      
      <View style={styles.dashboard}>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>困意 {drowsiness}%</Text>
        </View>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>信号 {signal}%</Text>
        </View>
      </View>

      <View style={styles.playerCard}>
        <Text style={styles.musicText}>🎵 {musicName}</Text>
        <View style={styles.btnGroup}>
          <Button title="选择本地音乐" onPress={pickAndPlay} color="#8E44AD" />
          <Button title={isPlaying ? "暂停" : "播放"} onPress={togglePlay} />
        </View>
      </View>

      <View style={styles.buttonContainer}>
        <Button title="重新扫描头环" onPress={scanAndConnect} color="#4A90E2" />
        {savedDeviceId ? (
          <View style={{marginTop: 10}}>
            <Text style={{textAlign: 'center', color: '#666'}}>已配对设备: {savedDeviceId.substring(0, 8)}...</Text>
            <Button title="清除配对记录" onPress={clearPairedDevice} color="#FF6B6B" />
          </View>
        ) : null}
      </View>
      
      <ScrollView style={styles.logBox}>
        {logs.map((l, i) => <Text key={i} style={styles.logText}>{l}</Text>)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#f0f2f5', marginTop: 30 },
  title: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', marginBottom: 20 },
  dashboard: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  dashItem: { flex: 1, backgroundColor: '#fff', padding: 15, borderRadius: 10, marginHorizontal: 5, alignItems: 'center' },
  dashLabel: { fontSize: 15, fontWeight: 'bold', color: '#333' },
  playerCard: { backgroundColor: '#fff', padding: 20, borderRadius: 15, elevation: 4, marginBottom: 20 },
  musicText: { fontSize: 16, marginBottom: 15, textAlign: 'center' },
  btnGroup: { flexDirection: 'row', justifyContent: 'space-around' },
  buttonContainer: { flexDirection: 'column', alignItems: 'center' },
  logBox: { flex: 1, marginTop: 10, backgroundColor: '#e0e0e0', padding: 10, borderRadius: 8 },
  logText: { fontSize: 12, color: '#333', marginBottom: 4 }
});