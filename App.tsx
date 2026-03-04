import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Button, ScrollView, StyleSheet, Platform, PermissionsAndroid } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

if (!global.Buffer) { global.Buffer = Buffer; }

// 将 BleManager 实例移到组件外部，实现单例模式
const bleManager = new BleManager();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// ⚠️ 请确保这是你电脑的 IP 地址
const WS_URL = 'ws://192.168.0.200:8001/ws/eeg';

const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL = '273e0001-4c4d-454d-96be-f03bac821358';
// 使用更简洁的方式定义 Athena 数据通道
const ATHENA_CHANNELS = ['273e0013', '273e0014', '273e0015'].map(id => `${id}-4c4d-454d-96be-f03bac821358`);

export default function App() {
  const [status, setStatus] = useState('等待操作...');
  const [logs, setLogs] = useState<string[]>([]);
  const [battery, setBattery] = useState<number | string>('读取中...');
  const [signal, setSignal] = useState<number | string>('检测中...');
  const [drowsiness, setDrowsiness] = useState<number | string>('计算中...'); // 新增困意指数状态
  const [waveData, setWaveData] = useState<number[]>(Array(60).fill(0));
  const [imuData, setImuData] = useState<any>(null);
  const [ppgData, setPpgData] = useState<any>(null);
  const ws = useRef<WebSocket | null>(null);
  const isConnecting = useRef(false);

  const log = (msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 15));
    setStatus(msg);
  };

  // 辅助函数：根据信号百分比返回颜色和状态文字
  const getSignalStatus = (val: number | string) => {
    if (typeof val !== 'number') return { text: val, color: '#888', icon: '⚪' };
    if (val >= 80) return { text: `${val}% (极佳)`, color: '#00E676', icon: '🟢' };
    if (val >= 40) return { text: `${val}% (一般)`, color: '#FFCA28', icon: '🟡' };
    return { text: `${val}% (接触不良)`, color: '#F44336', icon: '🔴' };
  };

  const sigStatus = getSignalStatus(signal);

  useEffect(() => {
    ws.current = new WebSocket(WS_URL);
    
    ws.current.onopen = () => {
      log('🟢 成功连接 FastAPI 后端');
      console.log('WebSocket 状态: 已打开');
    };
    
    ws.current.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        console.log('收到后端消息:', msg.type, msg);
        
        // 接收电量信息
        if (msg.type === 'battery') {
          setBattery(msg.value);
        }
        
        // 接收信号质量和困意指数（新）
        if (msg.type === 'metrics') {
          setSignal(msg.signal);
          setDrowsiness(msg.drowsiness);
        }
        
        // 接收EEG波形预览数据
        if (msg.type === 'eeg_preview') {
          setWaveData(prev => [...prev, ...msg.data].slice(-60));
        }
        
        // 保留原有的数据接收逻辑
        if (msg.type === 'EEG_PPG') {
          if (msg.eeg) setEegData(msg.eeg);
          if (msg.ppg) setPpgData(msg.ppg);
        }
        if (msg.type === 'IMU') {
          setImuData(msg);
        }
      } catch (error) {
        console.log('WebSocket消息解析错误:', error);
      }
    };
    
    ws.current.onerror = (e) => {
      log(`🔴 后端连接失败`);
      console.log('WebSocket 错误:', e);
    };
    
    ws.current.onclose = (e) => {
      log(`🔴 WebSocket连接已关闭`);
      console.log('WebSocket 关闭事件:', e);
    };

    return () => { 
      if (ws.current) {
        console.log('清理 WebSocket 连接');
        ws.current.close();
      }
    };
  }, []);

  // 简化并优化指令发送函数
  const sendCommand = async (device: Device, base64: string, name: string) => {
    return new Promise<void>(async (resolve) => {
      let resolved = false;
      let buffer = "";
      const sub = device.monitorCharacteristicForService(MUSE_SERVICE, MUSE_CONTROL, (err, char) => {
        if (err || resolved) return;
        if (char?.value) {
          const chunk = Buffer.from(char.value, 'base64').toString();
          buffer += chunk;
          if (buffer.includes('}') && buffer.includes('"rc":0')) {
            log(`✅ ${name} 成功`);
            resolved = true; 
            sub.remove(); 
            resolve();
          }
        }
      });
      
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, base64);
      
      setTimeout(() => { 
        if (!resolved) { 
          sub.remove(); 
          resolve(); 
        } 
      }, 2000);
    });
  };

  const startMuseProtocol = async (device: Device) => {
    try {
      log('🛡️ 启动 Athena 解锁序列...');
      
      // 1. 【核心修复：采用备份逻辑】在任何指令下发前，先全局监听控制通道与数据通道
      [MUSE_CONTROL, ...ATHENA_CHANNELS].forEach(uuid => {
        device.monitorCharacteristicForService(MUSE_SERVICE, uuid, (err, char) => {
          if (char?.value && ws.current?.readyState === 1) {
            // 解析所有通道的回执并统一转发给后端
            const channel = uuid.substring(4,8);
            ws.current!.send(JSON.stringify({ channel, data: char.value }));
          }
        });
      });

      // 2. 【核心修复：采用备份逻辑】恢复无阻塞的基础握手序列
      await sendCommand(device, 'A3YxCg==', 'Version (v1)');
      await sendCommand(device, 'AmgK', 'Halt (h)');
      await sendCommand(device, 'BnAxMDM1Cg==', 'Preset (p1035)');

      // 3. 严格的三段式推流激活脉冲
      log('🚀 激活推流 (dc001 x2)...');
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'BmRjMDAxCg==');
      await sleep(100);
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'A0wxCg=='); // L1 状态同步
      await sleep(200);
      await device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'BmRjMDAxCg==');
      
      log('🏁 协议序列完成，启动电量守护轮询...');

      // 4. 【保留新产品逻辑】通过纯异步写入获取电量，不阻塞主线
      setTimeout(() => {
        device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'AnMK').catch(() => {});
      }, 2000);
      
      setInterval(() => {
        device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, 'AnMK').catch(() => {});
      }, 30000);

    } catch (e: any) { 
      log(`❌ 协议异常: ${e.message}`); 
    }
  };

  const scanAndConnect = async () => {
    if (isConnecting.current) return;
    isConnecting.current = true;
    
    // 检查蓝牙状态
    const state = await bleManager.state();
    if (state !== 'PoweredOn') {
      log('蓝牙未开启，请先打开蓝牙');
      isConnecting.current = false;
      return;
    }
    
    log('正在请求蓝牙权限...');
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
          // 修复了原始代码中的bug：重复调用device.connect()
          const connectedDevice = await device.connect();
          await sleep(500);
          
          // 尝试扩容MTU以提高传输效率
          try {
            await connectedDevice.requestMTU(512);
            log('MTU 通道扩容至 512 字节完成');
          } catch (mtuErr) {
            log('MTU扩容被拒绝或不支持(可忽略)');
          }
          
          // 发现所有服务和特征值
          const readyDevice = await connectedDevice.discoverAllServicesAndCharacteristics();
          await sleep(500);
          log('✅ 服务发现完成');
          
          // 开始Muse协议通信
          startMuseProtocol(readyDevice);
        } catch (e: any) { 
          log(`连接失败: ${e.message}`); 
          isConnecting.current = false; 
        }
      }
    });
  };

  const requestBluetoothPermission = async () => {
    if (Platform.OS === 'android') {
      // Android 12 (S) 及以上版本需要特殊权限
      if (Platform.Version >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);

        const isScanGranted = granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED;
        const isConnectGranted = granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED;

        if (isScanGranted && isConnectGranted) {
          log('✅ 蓝牙权限已获得 (Android 12+)');
          return true;
        } else {
          log('❌ 蓝牙权限被拒绝');
          return false;
        }
      } else {
        // Android 12 以下版本
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );

        if (granted === PermissionsAndroid.RESULTS.GRANTED) {
          log('✅ 位置权限已获得 (Android <12)');
          return true;
        } else {
          log('❌ 位置权限被拒绝');
          return false;
        }
      }
    } else {
      // iOS 权限请求
      const granted = await bleManager.requestDevicePermissions();
      if (granted) {
        log('✅ 蓝牙权限已获得 (iOS)');
        return true;
      } else {
        log('❌ 蓝牙权限被拒绝 (iOS)');
        return false;
      }
    }
  };


  return (
    <View style={styles.container}>
      <Text style={styles.title}>超级个体 BCI 中枢</Text>

      {/* 仪表盘模块 */}
      <View style={styles.dashboard}>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>设备电量</Text>
          <Text style={styles.dashValue}>🔋 {typeof battery === 'number' ? `${battery}%` : battery}</Text>
        </View>
        <View style={styles.dashItem}>
          <Text style={styles.dashLabel}>佩戴信号质量</Text>
          <Text style={[styles.dashValue, { color: sigStatus.color }]}>
            {sigStatus.icon} {sigStatus.text}
          </Text>
        </View>
      </View>

      {/* 实时前额脑电波预览 (AF7) */}
      <Text style={styles.waveTitle}>入睡监测波形 (AF7前额)</Text>
      <View style={styles.waveContainer}>
        {waveData.map((val, i) => {
          // 将微伏电压 (-300uV ~ +300uV) 映射为柱状图高度 (2px ~ 100px)
          const height = Math.max(2, Math.min(100, 50 + (val * 0.15))); 
          return (
            <View key={i} style={{
              width: 4,
              height: height,
              backgroundColor: '#00E676', // 荧光绿
              marginHorizontal: 1,
              borderRadius: 2
            }} />
          );
        })}
      </View>

      <Button title="开始连接并扫描" onPress={scanAndConnect} color="#4A90E2" />
      
      <ScrollView style={styles.logBox}>
        {logs.map((l, i) => <Text key={i} style={styles.logText}>{l}</Text>)}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#f5f5f5' },
  title: { fontSize: 22, fontWeight: 'bold', marginBottom: 10, textAlign: 'center' },
  dashboard: {
    flexDirection: 'row', justifyContent: 'space-between', marginBottom: 15
  },
  dashItem: {
    flex: 1, backgroundColor: '#fff', padding: 15, borderRadius: 8, marginHorizontal: 5, alignItems: 'center'
  },
  dashLabel: { fontSize: 12, color: '#666', marginBottom: 5 },
  dashValue: { fontSize: 18, fontWeight: 'bold', color: '#333' },
  waveTitle: { fontSize: 14, fontWeight: 'bold', color: '#555', marginBottom: 5, marginLeft: 5 },
  waveContainer: {
    height: 120, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end',
    backgroundColor: '#111', paddingHorizontal: 5, borderRadius: 8, marginBottom: 20, overflow: 'hidden'
  },
  logBox: { flex: 1, backgroundColor: '#000', padding: 10, borderRadius: 8 },
  logText: { color: '#0f0', fontSize: 11, marginBottom: 2 }
});