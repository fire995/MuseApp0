import React, { useEffect, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch, TouchableOpacity
} from 'react-native';
import * as Network from 'expo-network';
import { useMuseDevice } from '../contexts/MuseDeviceContext';
import { useRingConn } from '../contexts/RingConnContext';

export default function SettingsScreen() {
    const {
        mindMonitorLog, isMindMonitorActive, mindMonitorEnabled, setMindMonitorEnabled,
        autoSaveDirectory, pickAutoSaveDirectory
    } = useMuseDevice();
    
    const {
        status: ringStatus, heartRate: ringHr, hrv: ringHrv,
        hrvTime: ringHrvTime, rrIntervals: ringRr,
        connect: ringConnect, disconnect: ringDisconnect
    } = useRingConn();

    const [localIp, setLocalIp] = useState<string>('获取中...');

    useEffect(() => {
        (async () => {
            try {
                const ip = await Network.getIpAddressAsync();
                setLocalIp(ip || '未知');
            } catch {
                setLocalIp('未知');
            }
        })();
    }, []);

    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 60 }}>
            <View style={s.header}>
                <Text style={s.title}>设置与数据</Text>
            </View>

            <View style={s.card}>
                <Text style={s.cardTitle}>📂 数据导出与保存</Text>
                <View style={[s.infoRow, { borderBottomWidth: 0 }]}>
                    <View style={{ flex: 1 }}>
                        <Text style={s.infoKey}>自动保存目录</Text>
                        <Text style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                            {autoSaveDirectory ? decodeURIComponent(autoSaveDirectory.split('%3A').pop() || '已设置自定义目录') : '未设置 (默认保存在应用内部)'}
                        </Text>
                    </View>
                    <TouchableOpacity
                        style={{ backgroundColor: '#2A7DB5', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8, justifyContent: 'center' }}
                        onPress={pickAutoSaveDirectory}
                    >
                        <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>更改目录</Text>
                    </TouchableOpacity>
                </View>
                <Text style={{ fontSize: 11, color: '#555', marginTop: 10, fontStyle: 'italic' }}>
                    冥想或睡眠/休息会话结束后，系统将自动将记录保存至该文件夹，不会再弹出分享确认框。
                </Text>
            </View>

            <View style={s.card}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <Text style={s.cardTitle}>🔗 Mind-Monitor 连接</Text>
                    <Switch
                        value={mindMonitorEnabled}
                        onValueChange={setMindMonitorEnabled}
                        trackColor={{ false: '#333', true: '#4CAF50' }}
                    />
                </View>

                {mindMonitorEnabled ? (
                    <View style={[s.infoRow, { borderBottomWidth: 0, paddingBottom: 12 }]}>
                        <View style={{ flex: 1 }}>
                            <View style={{ marginBottom: 6, backgroundColor: '#111', padding: 6, borderRadius: 4 }}>
                                <Text style={{ fontSize: 10, color: '#4CAF50' }}>OSC Target IP: {localIp}</Text>
                            </View>
                            <View>
                                {mindMonitorLog.length === 0 ? (
                                    <Text style={{ fontSize: 10, color: '#444' }}>等待接收数据包...</Text>
                                ) : (
                                    mindMonitorLog.slice(0, 5).map((log, i) => (
                                        <Text key={i} style={{ fontSize: 9, color: '#555', fontFamily: 'monospace' }}>{log}</Text>
                                    ))
                                )}
                            </View>
                        </View>
                        <View style={{ alignItems: 'flex-end', marginLeft: 10 }}>
                            <Text style={[s.infoVal, { color: isMindMonitorActive ? '#4CAF50' : '#888' }]}>
                                {isMindMonitorActive ? '📡 监听中' : '等待中'}
                            </Text>
                            <Text style={{ fontSize: 9, color: '#333', marginTop: 4 }}>Port: 5005</Text>
                        </View>
                    </View>
                ) : (
                    <Text style={{ color: '#555', fontSize: 12, fontStyle: 'italic', marginBottom: 12 }}>监听已关闭，手动开启后可接收波形数据。</Text>
                )}

                <View style={{ backgroundColor: '#22253A', height: 1, marginVertical: 8 }} />

                {/* RingConn 状态 */}
                <View style={[s.infoRow, { borderBottomWidth: 0, paddingBottom: 12 }]}>
                    <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                            <Text style={s.infoKey}>RingConn 智能戒指</Text>
                            <View style={{
                                marginLeft: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                                backgroundColor: ringStatus === 'connected' ? '#4CAF5020' : '#333'
                            }}>
                                <Text style={{ fontSize: 10, color: ringStatus === 'connected' ? '#4CAF50' : '#888' }}>
                                    {ringStatus === 'connected' ? '已连接' : ringStatus === 'connecting' ? '连接中...' : ringStatus === 'scanning' ? '搜索中...' : '未连接'}
                                </Text>
                            </View>
                        </View>
                        
                        {ringStatus === 'connected' ? (
                            <View style={{ backgroundColor: '#111', padding: 8, borderRadius: 6, marginTop: 4 }}>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <Text style={{ fontSize: 12, color: '#aaa' }}>实时心率 (BPM)</Text>
                                    <Text style={{ fontSize: 14, color: '#FF5252', fontWeight: 'bold' }}>{ringHr ?? '--'}</Text>
                                </View>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <View>
                                        <Text style={{ fontSize: 12, color: '#aaa' }}>估算 HRV (RMSSD)</Text>
                                        {ringHrvTime && <Text style={{ fontSize: 9, color: '#555' }}>测量于 {ringHrvTime}</Text>}
                                    </View>
                                    <Text style={{ fontSize: 14, color: '#6C5CE7', fontWeight: 'bold' }}>{ringHrv ? `${ringHrv} ms` : '--'}</Text>
                                </View>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                                    <Text style={{ fontSize: 12, color: '#aaa' }}>最近 RR 间期</Text>
                                    <Text style={{ fontSize: 12, color: '#4CAF50' }}>{ringRr.length > 0 ? ringRr.slice(-3).join(', ') : '--'}</Text>
                                </View>
                            </View>
                        ) : (
                            <Text style={{ fontSize: 10, color: '#555', marginTop: 4 }}>
                                请确保手机蓝牙已开启，并且戒指处于唤醒状态。
                            </Text>
                        )}
                    </View>
                    
                    <View style={{ justifyContent: 'center', marginLeft: 12 }}>
                        {ringStatus === 'disconnected' ? (
                            <TouchableOpacity
                                style={{ backgroundColor: '#2A7DB5', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
                                onPress={ringConnect}
                            >
                                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>连接</Text>
                            </TouchableOpacity>
                        ) : (
                            <TouchableOpacity
                                style={{ backgroundColor: '#FF5252', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
                                onPress={ringDisconnect}
                            >
                                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>断开</Text>
                            </TouchableOpacity>
                        )}
                    </View>
                </View>
            </View>

        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: { paddingHorizontal: 20, paddingTop: 54, paddingBottom: 20 },
    title: { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },

    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },

    infoRow: {
        flexDirection: 'row', justifyContent: 'space-between',
        paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#22253A'
    },
    infoKey: { fontSize: 12, color: '#666' },
    infoVal: { fontSize: 12, color: '#aaa', textAlign: 'right', flex: 1, marginLeft: 12 },
});
