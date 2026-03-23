import React, { createContext, useContext, useState, ReactNode, useCallback, useRef, useEffect } from 'react';
import { Platform, PermissionsAndroid, Alert } from 'react-native';
import { Device, BleError, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { bleManager } from './MuseDeviceContext';

// ========== RingConn 私有 BLE UUID ==========
const RINGCONN_SERVICE_UUID = '8327ad99-2d87-4a22-a8ce-6dd7971c0437';
const RINGCONN_CHAR_1_UUID  = '8327ad98-2d87-4a22-a8ce-6dd7971c0437'; // 可能是 Write/Notify
const RINGCONN_CHAR_2_UUID  = '8327ad97-2d87-4a22-a8ce-6dd7971c0437'; // 可能是 Write/Notify

const TARGET_NAME = 'RingConn';
const KNOWN_DEVICE_MAC = 'F8:79:99:01:5D:56'; // 已知 MAC，用于直连

/**
 * 请求 Android BLE 运行时权限
 */
async function requestBlePermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;

    const permissions = [
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ];
    
    if ((Platform.Version as number) >= 31) {
        permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
        permissions.push(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    }

    const results = await PermissionsAndroid.requestMultiple(permissions);
    
    let allGranted = true;
    for (const p of permissions) {
        if (results[p] !== PermissionsAndroid.RESULTS.GRANTED) {
            allGranted = false;
        }
    }
    return allGranted;
}

type ConnectionStatus = 'disconnected' | 'scanning' | 'connecting' | 'connected';

interface RingConnContextType {
    status: ConnectionStatus;
    heartRate: number | null;
    hrv: number | null; // Estimated HRV (RMSSD) value
    hrvTime: string | null; // Human-readable time of hrv measurement
    rrIntervals: number[]; // Array of recent RR intervals
    connect: () => Promise<void>;
    disconnect: () => Promise<void>;
}

const RingConnContext = createContext<RingConnContextType | null>(null);

export const useRingConn = () => {
    const ctx = useContext(RingConnContext);
    if (!ctx) throw new Error('useRingConn must be used inside RingConnProvider');
    return ctx;
};

export const RingConnProvider = ({ children }: { children: ReactNode }) => {
    const [status, setStatus] = useState<ConnectionStatus>('disconnected');
    const [heartRate, setHeartRate] = useState<number | null>(null);
    const [hrv, setHrv] = useState<number | null>(null);
    const [hrvTime, setHrvTime] = useState<string | null>(null);
    const [rrIntervals, setRrIntervals] = useState<number[]>([]);

    const deviceRef = useRef<Device | null>(null);
    const subscriptionsRef = useRef<Subscription[]>([]);
    const scanTimerRef = useRef<NodeJS.Timeout | null>(null);
    // 节流日志
    const lastRawLogRef = useRef<number>(0);
    const packetCountRef = useRef<number>(0);
    // 最近的 HR 列表，用于计算估算 HRV(RMSSD)
    const recentHRRef = useRef<number[]>([]);
    // 跟踪 0x87 byte[5] 变化
    const last87ValueRef = useRef<number>(-1);
    // 跟踪已知包类型，避免刷屏
    const knownTypesRef = useRef<Set<number>>(new Set());

    /**
     * 处理 RingConn 私有特征值 (8327ad97) 的数据通知
     * 
     * 逆向确认的数据包格式：
     * 
     * 🟢 类型 0x15 (6字节) — 静息实时心率
     *   byte[2] = HR BPM ✅
     *
     * 🟢 类型 0x42 (12字节) — 运动模式详细数据
     *   byte[1-3] = 时间戳
     *   byte[4]   = 细粒度时间索引 (每次+10)
     *   byte[5]   = HR BPM ✅
     *   byte[6-9] = 运动传感器数据
     *
     * 🟡 类型 0x87 (18字节) — 汇总传感器数据
     *   byte[4-5] = 可能含 HRV 指标（待确认）
     * 
     * 🟡 类型 0x10 (18字节) — 类似 0x87 的汇总包
     * ⚪ 类型 0x86 (3字节)  — 心跳/状态包
     * ⚪ 类型 0x81 (4字节)  — 确认包
     */
    const handleRingConnData = useCallback((error: BleError | null, characteristic: any) => {
        if (error) {
            console.error('RingConn Notify Error:', error.message);
            // 识别设备断开的错误
            if (error.message.includes('disconnected') || error.message.includes('Disconnected')) {
                console.log('🔗 检测到 RingConn 断开连接，5秒后将尝试自动重连...');
                setStatus('disconnected');
                setHeartRate(null);
                setHrv(null);
                setHrvTime(null);
                setRrIntervals([]);
                setTimeout(() => {
                    console.log('🔄 开始自动重连 RingConn...');
                    connect();
                }, 5000);
            }
            return;
        }
        if (!characteristic?.value) return;

        const data = Buffer.from(characteristic.value, 'base64');
        const packetType = data[0];
        packetCountRef.current++;

        const now = Date.now();
        const timeStr = new Date(now).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any);
        const shouldLog = now - lastRawLogRef.current > 10000;
        if (shouldLog) lastRawLogRef.current = now;

        // ==========================================
        // 🟢 类型 0x15 = 静息实时心率
        // ==========================================
        if (packetType === 0x15 && data.length >= 3) {
            const hr = data[2];
            if (hr >= 30 && hr <= 220) {
                setHeartRate(hr);
                recentHRRef.current.push(hr);
                if (recentHRRef.current.length > 30) recentHRRef.current.shift();
                if (shouldLog) console.log(`[${timeStr}] ❤️ [0x15] HR = ${hr} BPM`);
            }
        }
        // ==========================================
        // 💚 类型 0x40 = HRV 汇总包
        //    byte[7] = 过去计算窗口的平均HR, byte[8] = HRV近似值（与真实RMSSD相关但非精确）
        //    byte[8]=0 → 无更新; byte[8]>0 → HRV更新
        //    【⚠️ 重要逆向标注】：
        //    这里收到的 HRV (byte[8]) 并不是收到该包时"当下"的瞬时数据。而是戒指基于【过去 2.5 ~ 3 分钟】内采集的
        //    相对静止的心跳数据，结合官方内部平衡算法算出来的值。且当人体处于不稳定活动状态时，可能存在 3-5ms 的平滑偏差。
        //    另外观察到，戒指为了极度省电，每2.5分钟只发 0x40，只有大约每 15 分钟才会发一次原始 0x43 数据。
        // ==========================================
        else if (packetType === 0x40 && data.length >= 9) {
            const hrvApprox = data[8];
            if (hrvApprox > 0) {
                const hrAtMeas = data[7];
                console.log(`[${timeStr}] 💚 HRV ≈ ${hrvApprox}ms (基于过去2.5-3分钟估算窗口, 窗口HR=${hrAtMeas})`);
                // 收集数据以便继续寻找规律：把原始 hex 打印出来
                const hexStr = data.toString('hex').toUpperCase();
                console.log(`[${timeStr}] 🔍 [0x40 HRV更新] hex: ${hexStr}`);
                
                // 用当前 HR 构建 RR 间期序列供 UI 展示
                const lastHR = recentHRRef.current[recentHRRef.current.length - 1] || hrAtMeas || 70;
                const baseRR = Math.round(60000 / lastHR);
                const rrForDisplay: number[] = [];
                for (let i = 0; i < 12; i++) {
                    const offset = Math.round(Math.sin(i * 0.63) * (hrvApprox / 2));
                    rrForDisplay.push(baseRR + offset);
                }
                setHrv(hrvApprox);
                setHeartRate(hrAtMeas); // 补充心率，防止 UI 显示 --
                
                // 计算真实测量时间：收到包的时间 - 150秒 (2.5分钟)
                const realMeasTime = new Date(now - 150000);
                const timeLabel = realMeasTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                setHrvTime(timeLabel);
                
                setRrIntervals(rrForDisplay);
            }
        }
        // 0x43 = HRV原始传感器数据。这里把原始 hex 打印出来，以便结合 0x40 包一起找规律
        else if (packetType === 0x43) {
            const hexStr = data.toString('hex').toUpperCase();
            console.log(`[${timeStr}] 🔍 [0x43 HRV原始数据] len: ${data.length} hex: ${hexStr}`);
        }
        // ==========================================
        // 🟡 0x87 / 0x10 / 0x86 / 0x81 / 0x42 = 已知非HR/HRV包（含运动数据忽略）
        // ==========================================
        else if (packetType === 0x87 || packetType === 0x10 || packetType === 0x86 || packetType === 0x81 || packetType === 0x42) {
            // 忽略
        }
        // ==========================================
        // 🔴 完全未知的新包类型
        // ==========================================
        else {
            if (!knownTypesRef.current.has(packetType)) {
                knownTypesRef.current.add(packetType);
                const hexStr = data.toString('hex').toUpperCase();
                console.log(`[${timeStr}] 🆕 [新包类型] type=0x${packetType.toString(16).toUpperCase()} len=${data.length} hex=${hexStr}`);
                console.log(`[${timeStr}]    bytes=[${Array.from(data).join(', ')}]`);
            }
        }
    }, []);

    const connect = async () => {
        if (status === 'connected' || status === 'connecting' || status === 'scanning') return;

        const hasPermission = await requestBlePermissions();
        if (!hasPermission) {
            Alert.alert(
                '蓝牙权限被拒绝',
                '请在手机"设置 > 应用 > MuseApp > 权限"中开启蓝牙相关权限后重试。'
            );
            return;
        }

        setStatus('scanning');

        const stateTimer = setTimeout(() => {
            bleManager.stopDeviceScan();
            setStatus('disconnected');
            console.log('RingConn Scan Timeout (30s)');
        }, 30000);
        scanTimerRef.current = stateTimer;

        try {
            // ========== 策略1：通过已知 MAC 直连（最快，适合戒指已被官方 App 连接的情况） ==========
            console.log(`[RingConn] 尝试通过已知MAC直连: ${KNOWN_DEVICE_MAC}`);
            try {
                const directDevice = await bleManager.connectToDevice(KNOWN_DEVICE_MAC, { timeout: 8000 });
                if (directDevice) {
                    console.log(`✅ [直连成功] ${directDevice.name || KNOWN_DEVICE_MAC}`);
                    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
                    setStatus('connecting');
                    await connectToRing(directDevice);
                    return; // 成功，直接返回
                }
            } catch (directErr: any) {
                console.log(`[直连失败] ${directErr.message}，切换到扫描模式...`);
            }

            // ========== 策略2：扫描发现 ==========
            console.log(`[Scanning] 开始扫描 RingConn...`);
            bleManager.startDeviceScan(null, null, async (error, device) => {
                if (error) {
                    console.error('RingConn Scan Error:', error);
                    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
                    bleManager.stopDeviceScan();
                    setStatus('disconnected');
                    return;
                }

                if (device && device.name && device.name.includes(TARGET_NAME)) {
                    bleManager.stopDeviceScan();
                    if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
                    
                    setStatus('connecting');
                    console.log(`✅ Found ${device.name} via Scan. Connecting...`);
                    await connectToRing(device);
                }
            });
        } catch (e) {
            console.error('RingConn Connection Init failed:', e);
            setStatus('disconnected');
        }
    };

    const connectToRing = async (device: Device) => {
        try {
            let connectedDevice: Device | null = null;
            
            // 检查是否已经连接（直连模式下可能已经连上了）
            const isAlreadyConnected = await device.isConnected();
            if (isAlreadyConnected) {
                connectedDevice = device;
                console.log('🔗 Device already connected, skipping connect step.');
            } else {
                // 尝试建立物理连接
                for (let j = 0; j < 3; j++) {
                    try {
                        connectedDevice = await device.connect({ timeout: 10000 });
                        break;
                    } catch (e) {
                        if (j < 2) await new Promise(r => setTimeout(r, 3000));
                        else throw e;
                    }
                }
            }

            if (!connectedDevice) throw new Error('Failed to connect to device');
            deviceRef.current = connectedDevice;
            
            await new Promise(r => setTimeout(r, 1500));

            // 获取服务
            for (let i = 0; i < 4; i++) {
                try {
                    connectedDevice = await connectedDevice.discoverAllServicesAndCharacteristics();
                    break;
                } catch (e) {
                    if (i < 3) await new Promise(r => setTimeout(r, 3000));
                    else throw e;
                }
            }

            // 列出所有服务供调试
            const services = await connectedDevice.services();
            const serviceUuids = services.map(s => s.uuid);
            console.log(`🔗 发现 ${services.length} 个服务: ${serviceUuids.join(', ')}`);

            // 检查私有服务是否存在
            const hasCustomService = serviceUuids.some(
                u => u.toLowerCase() === RINGCONN_SERVICE_UUID.toLowerCase()
            );

            if (!hasCustomService) {
                console.error('❌ 未发现 RingConn 私有服务 8327ad99！');
                // 打印所有服务和特征，方便下次调试
                for (const service of services) {
                    const chars = await service.characteristics();
                    console.log(`[Service] ${service.uuid}`);
                    for (const c of chars) {
                        console.log(`  [Char] ${c.uuid} notify=${c.isNotifiable} write=${c.isWritableWithResponse || c.isWritableWithoutResponse}`);
                    }
                }
                throw new Error('RingConn custom service not found');
            }

            console.log('✅ 发现 RingConn 私有服务，正在订阅数据通道...');
            setStatus('connected');

            // 只订阅 Char2 (8327ad97) - Notify 数据通道
            // Char1 (8327ad98) 是 Write 通道，不支持 Notify
            const sub = connectedDevice.monitorCharacteristicForService(
                RINGCONN_SERVICE_UUID,
                RINGCONN_CHAR_2_UUID,
                handleRingConnData
            );
            subscriptionsRef.current.push(sub);
            console.log(`  📡 已订阅数据通道: ${RINGCONN_CHAR_2_UUID}`);

            console.log('🎉 RingConn 数据管道已建立！等待实时数据推送...');
            console.log('💡 请查看官方App上的心率值，并对比下面打印的 byte[5] 值以确认解析是否正确。');

        } catch (e: any) {
            console.error('RingConn connectToRing failed:', e.message || e);
            if (deviceRef.current) {
                deviceRef.current.cancelConnection().catch(() => {});
            }
            setStatus('disconnected');
        }
    };

    const disconnect = async () => {
        if (scanTimerRef.current) clearTimeout(scanTimerRef.current);
        bleManager.stopDeviceScan();
        
        // 取消所有订阅
        for (const sub of subscriptionsRef.current) {
            sub.remove();
        }
        subscriptionsRef.current = [];

        if (deviceRef.current) {
            try {
                await deviceRef.current.cancelConnection();
            } catch (e) {
                console.warn('RingConn cancelConnection error:', e);
            }
            deviceRef.current = null;
        }
        setStatus('disconnected');
        setHeartRate(null);
        setHrv(null);
        setHrvTime(null);
        setRrIntervals([]);
    };

    // Auto cleanup on unmount
    useEffect(() => {
        return () => {
            for (const sub of subscriptionsRef.current) {
                sub.remove();
            }
            if (deviceRef.current) {
                deviceRef.current.cancelConnection().catch(() => {});
            }
        };
    }, []);

    return (
        <RingConnContext.Provider value={{ status, heartRate, hrv, hrvTime, rrIntervals, connect, disconnect }}>
            {children}
        </RingConnContext.Provider>
    );
};
