import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Button, ScrollView, StyleSheet, Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

if (!global.Buffer) { global.Buffer = Buffer; }
const bleManager = new BleManager();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const WS_URL = 'ws://192.168.0.200:8001/ws/eeg'; 

const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL = '273e0001-4c4d-454d-96be-f03bac821358';
const ATHENA_CHANNELS = ['273e0013', '273e0014', '273e0015'].map(id => `${id}-4c4d-454d-96be-f03bac821358`);

export default function App() {
  const [status, setStatus] = useState('等待操作...');
  const [logs, setLogs] = useState<string[]>([]);
  
  const [battery, setBattery] = useState<number | string>('读取中...');
  const [signal, setSignal] = useState<number | string>('检测中...');
  const [drowsiness, setDrowsiness] = useState<number | string>('--'); 
  const [waveData, setWaveData] = useState<number[]>(Array(60).fill(0));
  
  const ws = useRef<WebSocket | null>(null);
  const isConnecting = useRef(false);
  const isAutoReconnecting = useRef(false);
  const deviceRef = useRef<Device | null>(null);

  const log = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 15));
    setStatus(msg);
  };

  useEffect(() => {
    ws.current = new WebSocket(WS_URL);
    ws.current.onopen = () => log('🟢 成功连接 FastAPI 后端');
    ws.current.onerror = () => log(`🔴 后端连接失败`);
    ws.current.onclose = () => log(`🔴 WebSocket连接已关闭`);
    
    ws.current.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'battery') setBattery(msg.value);
        if (msg.type === 'metrics') {
          setSignal(msg.signal);
          setDrowsiness(msg.drowsiness); 
        }
        if (msg.type === 'eeg_preview') {
          setWaveData(prev => [...prev, ...msg.data].slice(-60));
        }
      } catch (err) {}
    };

    return () => { ws.current?.close(); };
  }, []);

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

  const safeStartProtocol = async (device: Device) => {
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
        await safeStartProtocol(newDevice);
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
    
    log('正在扫描 Muse...');
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
          deviceRef.current = connectedDevice;
          
          await sleep(500);
          try { await connectedDevice.requestMTU(512); } catch (e) {}
          await connectedDevice.discoverAllServicesAndCharacteristics();
          log('✅ 服务发现完成');
          await safeStartProtocol(connectedDevice);
        } catch (e: any) { 
          log(`连接失败: ${e.message}`); 
          isConnecting.current = false; 
        }
      }
    });
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
      <Text style={styles.title}>超级个体 BCI 中枢</Text>

      <View style={styles.dashboard}>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>设备电量</Text>
          <Text style={styles.dashValue}>🔋 {typeof battery === 'number' ? `${battery}%` : battery}</Text>
        </View>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>佩戴信号</Text>
          <Text style={[styles.dashValue, { color: sigStatus.color }]}>
            {sigStatus.icon} {sigStatus.text}
          </Text>
        </View>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>困意指数</Text>
          <Text style={[styles.dashValue, { color: typeof drowsiness === 'number' && drowsiness > 60 ? '#FF5252' : '#4A90E2' }]}>
            💤 {typeof drowsiness === 'number' ? `${drowsiness}%` : drowsiness}
          </Text>
        </View>
      </View>

      <Text style={styles.waveTitle}>入睡监测波形 (0013通道)</Text>
      <View style={styles.waveContainer}>
        {waveData.map((val, i) => {
          const height = Math.max(2, Math.min(100, 50 + (val * 0.15))); 
          return (
            <View key={i} style={{width: 4, height: height, backgroundColor: '#00E676', marginHorizontal: 1, borderRadius: 2}} />
          );
        })}
      </View>

      <Button title="扫描并连接头环" onPress={scanAndConnect} color="#4A90E2" />
      
      <ScrollView style={styles.logBox}>
        {logs.map((l, i) => <Text key={i} style={styles.logText}>{l}</Text>)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#f5f5f5', marginTop: 30 },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 15, textAlign: 'center' },
  dashboard: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15 },
  dashItem: { flex: 1, backgroundColor: '#fff', padding: 10, borderRadius: 8, marginHorizontal: 3, alignItems: 'center', elevation: 2 },
  dashLabel: { fontSize: 11, color: '#666', marginBottom: 5 },
  dashValue: { fontSize: 15, fontWeight: 'bold', color: '#333' },
  waveTitle: { fontSize: 14, fontWeight: 'bold', color: '#555', marginBottom: 5, marginLeft: 5 },
  waveContainer: { height: 120, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', backgroundColor: '#111', paddingHorizontal: 5, borderRadius: 8, marginBottom: 20, overflow: 'hidden' },
  logBox: { flex: 1, marginTop: 10, backgroundColor: '#e0e0e0', padding: 10, borderRadius: 8 },
  logText: { fontSize: 12, color: '#333', marginBottom: 4 }
});