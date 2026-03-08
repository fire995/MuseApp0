import React, { createContext, useContext, useState, useEffect, useRef, useCallback, ReactNode } from 'react';
import { Platform, AppState, PermissionsAndroid, Linking } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import TrackPlayer, { Capability, AppKilledPlaybackBehavior, RepeatMode } from 'react-native-track-player';
import * as DocumentPicker from '@react-native-documents/picker';
// @ts-ignore
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import ReactNativeForegroundService from '@supersami/rn-foreground-service';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
    parseMusePacket, analyzeFrequency, calculateSignalQuality,
    HeartRateCalculator, EEG_CHANNEL_NAMES,
} from '../../utils/MuseDecoder';

if (!global.Buffer) { global.Buffer = Buffer; }
ReactNativeForegroundService.register({ config: { alert: false, onServiceErrorCallBack: () => { } } });

const bleManager = new BleManager();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const MUSE_SERVICE = '0000fe8d-0000-1000-8000-00805f9b34fb';
const MUSE_CONTROL = '273e0001-4c4d-454d-96be-f03bac821358';
const ATHENA_CHANNELS = ['273e0013', '273e0014', '273e0015', '273e0016']
    .map(id => `${id}-4c4d-454d-96be-f03bac821358`);
const PPG_CHANNELS = ['273e0010', '273e0011']
    .map(id => `${id}-4c4d-454d-96be-f03bac821358`);

const CMD_HALT = 'AmgK';
const CMD_PRESET_HI = 'BnAxMDM1Cg==';
const CMD_PRESET_LO = 'BnAxMDM0Cg=='; // p1034, sleep mode
const CMD_START = 'BmRjMDAxCg==';
const CMD_STATUS = 'AnMK';

type SignalLevel = 'good' | 'ok' | 'poor' | 'none';
type SamplingMode = 'dense' | 'sparse';

interface MuseDeviceContextType {
    battery: number | string;
    signalLevel: SignalLevel;
    signalScore: number;
    electrodeQuality: Record<string, number>;
    packetsRx: number;
    samplingMode: SamplingMode;
    savedDeviceId: string | null;
    thetaWave: number[];
    isPlaying: boolean;
    musicName: string;
    isSaving: boolean;
    savePath: string;
    saveDuration: number;
    denseMins: number;
    setDenseMins: (v: number) => void;
    heartRate: number | null;
    // 自动保存设置
    autoSaveEnabled: boolean;
    setAutoSaveEnabled: (v: boolean) => void;
    autoSaveIntervalSec: number;
    setAutoSaveIntervalSec: (v: number) => void;
    autoSaveRetainDays: number;
    setAutoSaveRetainDays: (v: number) => void;
    autoSaveTempSize: number; // bytes, 当前临时文件夹总大小
    clearAutoSaveTempFiles: () => Promise<void>;

    scanAndConnect: () => Promise<void>;
    clearPairedDevice: () => Promise<void>;
    toggleSave: () => Promise<void>;
    exportSavedFile: () => Promise<void>;
    pickAndPlay: () => Promise<void>;
    togglePlay: () => Promise<void>;
}

const MuseDeviceContext = createContext<MuseDeviceContextType | null>(null);

export const useMuseDevice = () => {
    const ctx = useContext(MuseDeviceContext);
    if (!ctx) throw new Error('useMuseDevice must be used inside MuseDeviceProvider');
    return ctx;
};

export const MuseDeviceProvider = ({ children }: { children: ReactNode }) => {
    const [battery, setBattery] = useState<number | string>('--');
    const [signalLevel, setSignalLevel] = useState<SignalLevel>('none');
    const [signalScore, setSignalScore] = useState(0);
    const [electrodeQuality, setElectrodeQuality] = useState<Record<string, number>>({ TP9: 0, AF7: 0, AF8: 0, TP10: 0 });
    const [packetsRx, setPacketsRx] = useState(0);
    const [samplingMode, setSamplingMode] = useState<SamplingMode>('dense');
    const [savedDeviceId, setSavedDeviceId] = useState<string | null>(null);
    const [thetaWave, setThetaWave] = useState<number[]>([]);

    const [isPlaying, setIsPlaying] = useState(false);
    const [musicName, setMusicName] = useState('未加载音乐');

    const [isSaving, setIsSaving] = useState(false);
    const isSavingRef = useRef(false);
    useEffect(() => { isSavingRef.current = isSaving; }, [isSaving]);
    const [savePath, setSavePath] = useState('');
    const [saveDuration, setSaveDuration] = useState(0);
    const [denseMins, setDenseMins] = useState(30);
    const [heartRate, setHeartRate] = useState<number | null>(null);

    // 自动保存设置（从 AsyncStorage 加载，默认值）
    const [autoSaveEnabled, setAutoSaveEnabledState] = useState(true);
    const [autoSaveIntervalSec, setAutoSaveIntervalSecState] = useState(120);
    const [autoSaveRetainDays, setAutoSaveRetainDaysState] = useState(7);
    const [autoSaveTempSize, setAutoSaveTempSize] = useState(0);
    const autoSaveEnabledRef = useRef(true);
    const autoSaveIntervalSecRef = useRef(120);
    const autoSaveRetainDaysRef = useRef(7);

    const logFileUri = useRef<string | null>(null);
    const fileBuffer = useRef<string>('');
    const filePartIndex = useRef<number>(1);
    const deviceRef = useRef<Device | null>(null);
    const isConnecting = useRef(false);
    const isAutoRecon = useRef(false);
    const userDisconnect = useRef(false);
    const heartbeat = useRef<ReturnType<typeof setInterval> | null>(null);
    const samplingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const signalBuf = useRef<number[]>([]);

    const lastDataTime = useRef<number>(0);
    const dataFlowActive = useRef<boolean>(false);
    const packetCountRef = useRef<number>(0);
    const saveRowCount = useRef<number>(0);

    const softwareRawRef = useRef<Record<string, number>>(Object.fromEntries(EEG_CHANNEL_NAMES.map(ch => [ch, 0])));
    const diagnosticTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const dataQualityTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const autoSaveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const saveDurationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const eegBufRef = useRef<Record<string, number[]>>(Object.fromEntries(EEG_CHANNEL_NAMES.map(ch => [ch, []])));
    const hrCalcRef = useRef(new HeartRateCalculator());
    const lastHRTime = useRef<number>(0);

    // 日志方法简化为只输出到控制台
    const addLog = useCallback((msg: string) => {
        console.log(`[MuseApp] ${msg}`);
    }, []);

    const recalcTotalSignal = useCallback(() => {
        const newUIQuality: Record<string, number> = {};
        ['TP9', 'AF7', 'AF8', 'TP10'].forEach((ch: string) => { newUIQuality[ch] = softwareRawRef.current[ch] || 0; });
        setElectrodeQuality(newUIQuality);

        // 仅计算核心 4 通道的平均值作为总得分
        const mainChannels = ['TP9', 'AF7', 'AF8', 'TP10'];
        const values = mainChannels.map(ch => softwareRawRef.current[ch] || 0);
        const avgSoft = values.reduce((a, b) => a + b, 0) / values.length;
        let finalScore = Math.round(avgSoft);

        const now = Date.now();
        // 3秒无数据 → 信号为0（比之前5秒更快检测断开）
        if (lastDataTime.current === 0 || now - lastDataTime.current > 3000) {
            finalScore = 0;
        }

        // 中位数滤波窗口从5缩小到3，让信号状态更快响应
        const buf = signalBuf.current;
        buf.push(finalScore);
        if (buf.length > 3) buf.shift();
        const sorted = [...buf].sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)];

        setSignalScore(mid);
        setSignalLevel(mid >= 65 ? 'good' : mid >= 35 ? 'ok' : mid > 0 ? 'poor' : 'none');
    }, []);

    useEffect(() => {
        const setupMusicPlayer = async () => {
            try {
                await TrackPlayer.setupPlayer();
                await TrackPlayer.updateOptions({
                    android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification },
                    capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
                });
                await TrackPlayer.setRepeatMode(RepeatMode.Track);
            } catch { }
        };
        setupMusicPlayer();

        // 初始化本地文件系统
        (async () => {
            try {
                const dirUri = FileSystem.documentDirectory;
                if (!dirUri) return;
                const files = await FileSystem.readDirectoryAsync(dirUri);
                const now = Date.now();
                const retainMs = autoSaveRetainDaysRef.current * 24 * 3600 * 1000;
                for (const file of files) {
                    if (file.endsWith('.csv') || file.endsWith('.zip') || file.endsWith('.txt')) {
                        const fileUri = file.startsWith('file://') ? file : dirUri + file;
                        const fileInfo = await FileSystem.getInfoAsync(fileUri);
                        if (fileInfo.exists && !fileInfo.isDirectory && (now - (fileInfo.modificationTime || 0) * 1000) > retainMs) {
                            await FileSystem.deleteAsync(fileUri, { idempotent: true });
                            console.log(`🗑️ 已清理过期日志 ${file}（超过 ${autoSaveRetainDaysRef.current} 天）`);
                        }
                    }
                }
            } catch (e) { }
            filePartIndex.current = 1;
            setSavePath('muse_data.csv');
        })();

        checkSavedDevice();

        const appStateSub = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'background' || nextState === 'inactive') {
                flushBufferToFile();
            }
        });

        diagnosticTimer.current = setInterval(() => {
            const pktTotal = packetCountRef.current;
            const saving = isSavingRef.current;
            if (pktTotal > 0 || saving) {
                if (lastDataTime.current > 0) recalcTotalSignal();
            }
        }, 5000);

        // 每 1 秒计算一次信号质量（比之前2秒更快更新）
        dataQualityTimer.current = setInterval(() => {
            if (lastDataTime.current === 0) return;
            for (const [chName, buf] of Object.entries(eegBufRef.current)) {
                // 新算法最少需要 32 个样本（之前要 64 个）
                if (buf.length >= 32) {
                    softwareRawRef.current[chName] = calculateSignalQuality(buf);
                }
            }
            recalcTotalSignal();
        }, 1000);

        return () => {
            if (heartbeat.current) clearInterval(heartbeat.current);
            if (samplingTimer.current) clearTimeout(samplingTimer.current);
            if (diagnosticTimer.current) clearInterval(diagnosticTimer.current);
            if (dataQualityTimer.current) clearInterval(dataQualityTimer.current);
            appStateSub.remove();
        };
    }, []);

    const MAX_PART_SIZE = 5 * 1024 * 1024;
    const BUFFER_FLUSH_THRESHOLD = 64 * 1024; // 64KB，更激进的防闪退策略
    const flushBufferToFile = async () => {
        if (!logFileUri.current || fileBuffer.current.length === 0) return;
        const chunk = fileBuffer.current;
        fileBuffer.current = '';
        try {
            const fileInfo = await FileSystem.getInfoAsync(logFileUri.current);
            if (fileInfo.exists && fileInfo.size && fileInfo.size > MAX_PART_SIZE) {
                filePartIndex.current += 1;
                const baseName = logFileUri.current.replace(/_part\d+\.txt$/, '').replace(/\.txt$/, '');
                logFileUri.current = `${baseName}_part${filePartIndex.current}.txt`;
            }
            if (!fileInfo.exists || (fileInfo.exists && fileInfo.size && fileInfo.size > MAX_PART_SIZE)) {
                await FileSystem.writeAsStringAsync(logFileUri.current, chunk, { encoding: FileSystem.EncodingType.UTF8 });
            } else {
                const existing = await FileSystem.readAsStringAsync(logFileUri.current, { encoding: FileSystem.EncodingType.UTF8 });
                await FileSystem.writeAsStringAsync(logFileUri.current, existing + chunk, { encoding: FileSystem.EncodingType.UTF8 });
            }
        } catch (e) {
            fileBuffer.current = chunk + fileBuffer.current;
        }
    };

    const processThetaWave = (rawSamples: number[]) => {
        if (rawSamples.length === 0) return;
        setThetaWave(prev => {
            const newData = [...prev, ...rawSamples];
            return newData.slice(-120);
        });
    };

    const analyzeDrowsiness = async (thetaEnergy: number, alphaEnergy: number) => {
        const drowsinessScore = (thetaEnergy / (alphaEnergy + 1)) * 100;
        if (drowsinessScore > 75 && isPlaying) {
            try {
                const vol = await TrackPlayer.getVolume();
                if (vol > 0.1) {
                    await TrackPlayer.setVolume(Math.max(0.1, vol - 0.05));
                    addLog(`💤 调低音量并逐渐变弱...`);
                }
            } catch (e) { }
        }
    };

    const handleMuseDataPacket = (channel: string, base64Data: string) => {
        const now = Date.now();
        lastDataTime.current = now;
        packetCountRef.current += 1;
        const pktNum = packetCountRef.current;

        if (!dataFlowActive.current) {
            dataFlowActive.current = true;
            recalcTotalSignal();
        }

        let decoded;
        try {
            decoded = parseMusePacket(base64Data, channel);
        } catch (e) { return; }

        if (isSavingRef.current && logFileUri.current) {
            const sig = signalBuf.current.length > 0 ? signalBuf.current[signalBuf.current.length - 1] : 0;
            const hrStr = heartRate != null ? `hr=${heartRate}` : 'hr=--';
            const timestamp = new Date().toISOString();
            const line = `${timestamp} | ch=${channel} | type=${decoded.packetTypeName} | sig=${sig} | ${hrStr} | ${base64Data}\n`;
            fileBuffer.current += line;
            saveRowCount.current += 1;
            if (fileBuffer.current.length > BUFFER_FLUSH_THRESHOLD) flushBufferToFile();
        }

        if (decoded.hasEEG) {
            let allSamples: number[] = [];
            for (const [chName, rawSamples] of Object.entries(decoded.eeg)) {
                const samples = rawSamples as number[];
                if (!samples || samples.length === 0) continue;
                const buf = eegBufRef.current[chName];
                if (buf) {
                    buf.push(...samples);
                    if (buf.length > 512) buf.splice(0, buf.length - 512);
                }
                allSamples = allSamples.concat(samples);
            }
            const primarySamples = (decoded.eeg['TP9'] as number[]) ?? (decoded.eeg['AF7'] as number[]) ?? allSamples;
            if (primarySamples.length > 0) {
                processThetaWave(primarySamples);
                const { theta, alpha } = analyzeFrequency(primarySamples);
                analyzeDrowsiness(theta, alpha);
            }
            setPacketsRx(prev => prev + 1);
        }

        if (decoded.hasPPG && decoded.ppg.length > 0) {
            const bpm = hrCalcRef.current.push(decoded.ppg);
            if (bpm !== null) {
                if (now - lastHRTime.current > 2000) {
                    lastHRTime.current = now;
                    setHeartRate(bpm);
                }
            }
        }
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
            }
        } catch (err) { }
    };

    const togglePlay = async () => {
        try {
            if (isPlaying) { await TrackPlayer.pause(); setIsPlaying(false); }
            else { await TrackPlayer.play(); setIsPlaying(true); }
        } catch { }
    };

    const startForegroundCapture = async () => {
        if (Platform.OS === 'android') {
            await ReactNativeForegroundService.start({
                id: 144,
                title: 'Muse BCI 采集中',
                message: '正在后台接收并存储脑波数据...',
                icon: 'ic_launcher',
                setOnlyAlertOnce: "true",
                color: '#000000',
                visibility: 'public',
                // @ts-ignore
                ServiceType: 'connectedDevice' as any,
            });
            await activateKeepAwakeAsync('muse-ble-lock');
        }

        try {
            if (!isPlaying) {
                const silenceAsset = require('../../assets/silence.wav');
                await TrackPlayer.reset();
                await TrackPlayer.add({
                    id: 'keep_alive_silence',
                    url: silenceAsset,
                    title: '后台保活',
                    artist: '系统',
                });
                await TrackPlayer.setRepeatMode(RepeatMode.Track);
                await TrackPlayer.play();
            }
        } catch { }
    };

    const stopForegroundCapture = async () => {
        if (Platform.OS === 'android') {
            ReactNativeForegroundService.stop();
            deactivateKeepAwake('muse-ble-lock');
        }

        try {
            if (!isPlaying) {
                await TrackPlayer.stop();
            }
        } catch { }
    };

    const toggleSave = async () => {
        if (!isSaving) {
            setIsSaving(true);
            saveRowCount.current = 0;
            fileBuffer.current = '';
            filePartIndex.current = 1;
            try {
                const timeStr = new Date().toISOString().replace(/[:.]/g, '-');
                const fileName = `muse_data_${timeStr}.txt`;
                const uri = `${FileSystem.documentDirectory}${fileName}`;
                const modeStr = samplingMode === 'dense' ? 'p1035模式 EEG 256Hz (7通道) + PPG 64Hz' : 'p1034模式 低功耗 (睡眠预设)';
                const header = `=== Muse EEG 数据记录 ===\n开始时间: ${new Date().toLocaleString()}\n采样频率: ${modeStr}\n格式: 时间 | ch=通道 | type=包类型 | sig=信号分 | hr=心率BPM | Base64原始数据\n${'='.repeat(60)}\n`;
                await FileSystem.writeAsStringAsync(uri, header, { encoding: FileSystem.EncodingType.UTF8 });
                logFileUri.current = uri;
                setSavePath(fileName);
            } catch (e) { setIsSaving(false); return; }

            setSaveDuration(0);
            if (saveDurationTimerRef.current) clearInterval(saveDurationTimerRef.current);
            saveDurationTimerRef.current = setInterval(() => { setSaveDuration(prev => prev + 1); }, 1000);
            startForegroundCapture();

            if (autoSaveTimerRef.current) clearInterval(autoSaveTimerRef.current);
            if (autoSaveEnabledRef.current) {
                autoSaveTimerRef.current = setInterval(
                    () => { flushBufferToFile(); },
                    autoSaveIntervalSecRef.current * 1000
                );
            }
        } else {
            setIsSaving(false);
            if (autoSaveTimerRef.current) { clearInterval(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
            if (saveDurationTimerRef.current) { clearInterval(saveDurationTimerRef.current); saveDurationTimerRef.current = null; }
            await flushBufferToFile();
            logFileUri.current = null;
            hrCalcRef.current.reset();
            setHeartRate(null);
            stopForegroundCapture();
        }
    };

    const exportSavedFile = async () => {
        try {
            await flushBufferToFile();
            const documentDir = FileSystem.documentDirectory;
            if (!documentDir) return;
            const files = await FileSystem.readDirectoryAsync(documentDir);
            const dataFiles = files.filter(f => (f.startsWith('muse_log_') || f.startsWith('muse_data_')) && f.endsWith('.txt'));
            if (dataFiles.length === 0) return;
            const latestFile = dataFiles.sort().reverse()[0];
            const fileUri = `${documentDir}${latestFile}`;
            const fileInfo = await FileSystem.getInfoAsync(fileUri);
            if (fileInfo.exists) { await Sharing.shareAsync(fileUri); }
        } catch { }
    };

    const write = (device: Device, cmd: string) => device.writeCharacteristicWithoutResponseForService(MUSE_SERVICE, MUSE_CONTROL, cmd).catch(() => { });

    const switchToLowPower = async (device: Device) => {
        setSamplingMode('sparse');
        await write(device, CMD_PRESET_LO);
        await sleep(300);
        await write(device, CMD_START);
        await sleep(150);
        await write(device, CMD_START);

        // 如果正在保存数据，向文件中注入一条模式切换日志
        if (isSavingRef.current && logFileUri.current) {
            const timestamp = new Date().toISOString();
            fileBuffer.current += `${timestamp} | ch=SYS | type=MODE_SWITCH | sig=0 | hr=-- | === Switched to LOW POWER (p1034) ===\n`;
            saveRowCount.current += 1;
            if (fileBuffer.current.length > BUFFER_FLUSH_THRESHOLD) flushBufferToFile();
        }
    };

    const startAdaptiveSampling = (device: Device, denseMinutes: number) => {
        if (samplingTimer.current) clearTimeout(samplingTimer.current);
        if (denseMinutes === 0) { switchToLowPower(device); return; }
        samplingTimer.current = setTimeout(async () => { switchToLowPower(device); }, denseMinutes * 60 * 1000);
    };

    const reconnectLoop = async (device: Device) => {
        while (true) {
            try {
                const d = await device.connect();
                await sleep(500);
                await d.discoverAllServicesAndCharacteristics();
                if (Platform.OS === 'android') { try { await d.requestMTU(512); } catch { } }
                await startMuseProtocol(d);
                isAutoRecon.current = false;
                break;
            } catch { await sleep(3000); }
        }
    };

    const startMuseProtocol = async (device: Device) => {
        try {
            device.onDisconnected(() => {
                if (userDisconnect.current) return;
                if (!isAutoRecon.current) { isAutoRecon.current = true; reconnectLoop(device); }
            });
            device.monitorCharacteristicForService(MUSE_SERVICE, MUSE_CONTROL, (error, char) => {
                if (error || !char?.value) return;
                const txt = Buffer.from(char.value, 'base64').toString();
                const bpMatch = txt.match(/"bp"\s*:\s*([\d.]+)/);
                if (bpMatch) { setBattery(Math.round(parseFloat(bpMatch[1]))); }
            });
            const sendCmd = (b64: string) => new Promise<void>(resolve => {
                write(device, b64);
                setTimeout(resolve, 2000);
            });
            await sendCmd(CMD_HALT);

            // Reconnect 时，尊重当前的 samplingMode
            // 如果是因为 denseMins 到了而变成了 sparse，重连后保持 sparse
            if (samplingMode === 'dense') {
                await sendCmd(CMD_PRESET_HI);
            } else {
                await sendCmd(CMD_PRESET_LO);
            }

            [...ATHENA_CHANNELS, ...PPG_CHANNELS].forEach(uuid => {
                device.monitorCharacteristicForService(MUSE_SERVICE, uuid, (error, char) => {
                    if (error) return;
                    if (char?.value) handleMuseDataPacket(uuid.substring(4, 8), char.value);
                });
            });
            await write(device, CMD_START);
            await sleep(150);
            await write(device, CMD_START);
            if (heartbeat.current) clearInterval(heartbeat.current);
            setTimeout(() => write(device, CMD_STATUS), 2000);
            heartbeat.current = setInterval(() => write(device, CMD_STATUS), 30000);

            // 重新开始自适应采样逻辑（如果在 dense 状态）
            if (samplingMode === 'dense') {
                startAdaptiveSampling(device, denseMins);
            }
        } catch { }
    };

    const scanAndConnect = async () => {
        if (isConnecting.current) return;
        isConnecting.current = true;
        userDisconnect.current = false;
        const state = await bleManager.state();
        if (state !== 'PoweredOn') { isConnecting.current = false; return; }
        if (Platform.OS === 'android') {
            const g = await PermissionsAndroid.requestMultiple([
                PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
                PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
                PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            ]);
            if (g['android.permission.BLUETOOTH_SCAN'] !== PermissionsAndroid.RESULTS.GRANTED) { isConnecting.current = false; return; }
        }
        bleManager.startDeviceScan(null, null, async (error, device) => {
            if (error) { isConnecting.current = false; return; }
            if (device?.name?.includes('Muse')) {
                bleManager.stopDeviceScan();
                try {
                    const d = await device.connect();
                    await AsyncStorage.setItem('MUSE_DEVICE_ID', d.id);
                    setSavedDeviceId(d.id);
                    await sleep(500);
                    await d.discoverAllServicesAndCharacteristics();
                    if (Platform.OS === 'android') { try { await d.requestMTU(512); } catch { } }
                    deviceRef.current = d;
                    await startMuseProtocol(d);
                } catch { isConnecting.current = false; }
            }
        });
        setTimeout(() => { bleManager.stopDeviceScan(); isConnecting.current = false; }, 10000);
    };

    const checkSavedDevice = async () => {
        const id = await AsyncStorage.getItem('MUSE_DEVICE_ID');
        if (!id) return;
        setSavedDeviceId(id);
        userDisconnect.current = false;
        try {
            const d = await bleManager.connectToDevice(id);
            await sleep(500);
            await d.discoverAllServicesAndCharacteristics();
            if (Platform.OS === 'android') { try { await d.requestMTU(512); } catch { } }
            deviceRef.current = d;
            await startMuseProtocol(d);
        } catch { }
    };

    const clearPairedDevice = async () => {
        userDisconnect.current = true;
        if (samplingTimer.current) { clearTimeout(samplingTimer.current); samplingTimer.current = null; }
        if (heartbeat.current) { clearInterval(heartbeat.current); heartbeat.current = null; }
        isAutoRecon.current = false;
        try {
            if (deviceRef.current) await deviceRef.current.cancelConnection();
        } catch { }
        deviceRef.current = null;
        await AsyncStorage.removeItem('MUSE_DEVICE_ID');
        setSavedDeviceId(null);
        setSamplingMode('dense');
        setTimeout(() => { userDisconnect.current = false; }, 1000);
    };

    // ---- 自动保存设置的持久化 setter ----
    const setAutoSaveEnabled = useCallback(async (v: boolean) => {
        autoSaveEnabledRef.current = v;
        setAutoSaveEnabledState(v);
        await AsyncStorage.setItem('AUTO_SAVE_ENABLED', JSON.stringify(v));
        // 重新绑定定时器
        if (autoSaveTimerRef.current) { clearInterval(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
        if (v && isSavingRef.current) {
            autoSaveTimerRef.current = setInterval(
                () => { flushBufferToFile(); },
                autoSaveIntervalSecRef.current * 1000
            );
        }
    }, []);

    const setAutoSaveIntervalSec = useCallback(async (v: number) => {
        autoSaveIntervalSecRef.current = v;
        setAutoSaveIntervalSecState(v);
        await AsyncStorage.setItem('AUTO_SAVE_INTERVAL', JSON.stringify(v));
        // 重新绑定定时器（仅在采集中时）
        if (autoSaveTimerRef.current) { clearInterval(autoSaveTimerRef.current); autoSaveTimerRef.current = null; }
        if (autoSaveEnabledRef.current && isSavingRef.current) {
            autoSaveTimerRef.current = setInterval(
                () => { flushBufferToFile(); },
                v * 1000
            );
        }
    }, []);

    const setAutoSaveRetainDays = useCallback(async (v: number) => {
        autoSaveRetainDaysRef.current = v;
        setAutoSaveRetainDaysState(v);
        await AsyncStorage.setItem('AUTO_SAVE_RETAIN_DAYS', JSON.stringify(v));
    }, []);

    // 计算并刷新临时文件夹大小
    const refreshTempSize = useCallback(async () => {
        try {
            const dir = FileSystem.documentDirectory;
            if (!dir) return;
            const files = await FileSystem.readDirectoryAsync(dir);
            let total = 0;
            for (const f of files) {
                if (f.startsWith('muse_data_') && f.endsWith('.txt')) {
                    const info = await FileSystem.getInfoAsync(dir + f);
                    if (info.exists && !info.isDirectory) total += (info.size ?? 0);
                }
            }
            setAutoSaveTempSize(total);
        } catch { }
    }, []);

    // 清理临时文件（手动触发）
    const clearAutoSaveTempFiles = useCallback(async () => {
        try {
            const dir = FileSystem.documentDirectory;
            if (!dir) return;
            const files = await FileSystem.readDirectoryAsync(dir);
            for (const f of files) {
                if ((f.startsWith('muse_data_') || f.startsWith('muse_log_')) && (f.endsWith('.txt') || f.endsWith('.csv'))) {
                    await FileSystem.deleteAsync(dir + f, { idempotent: true });
                }
            }
            setAutoSaveTempSize(0);
        } catch { }
    }, []);

    // 初始化：从 AsyncStorage 恢复自动保存设置
    useEffect(() => {
        (async () => {
            try {
                const en = await AsyncStorage.getItem('AUTO_SAVE_ENABLED');
                const interval = await AsyncStorage.getItem('AUTO_SAVE_INTERVAL');
                const retain = await AsyncStorage.getItem('AUTO_SAVE_RETAIN_DAYS');
                if (en !== null) { const v = JSON.parse(en); autoSaveEnabledRef.current = v; setAutoSaveEnabledState(v); }
                if (interval !== null) { const v = JSON.parse(interval); autoSaveIntervalSecRef.current = v; setAutoSaveIntervalSecState(v); }
                if (retain !== null) { const v = JSON.parse(retain); autoSaveRetainDaysRef.current = v; setAutoSaveRetainDaysState(v); }
            } catch { }
            await refreshTempSize();
        })();
    }, []);

    return (
        <MuseDeviceContext.Provider value={{
            battery, signalLevel, signalScore, electrodeQuality, packetsRx, samplingMode, savedDeviceId, thetaWave,
            isPlaying, musicName, isSaving, savePath, saveDuration, denseMins, setDenseMins, heartRate,
            autoSaveEnabled, setAutoSaveEnabled,
            autoSaveIntervalSec, setAutoSaveIntervalSec,
            autoSaveRetainDays, setAutoSaveRetainDays,
            autoSaveTempSize, clearAutoSaveTempFiles,
            scanAndConnect, clearPairedDevice, toggleSave, exportSavedFile, pickAndPlay, togglePlay
        }}>
            {children}
        </MuseDeviceContext.Provider>
    );
};
