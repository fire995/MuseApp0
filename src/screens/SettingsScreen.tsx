import React, { useEffect, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView, Switch
} from 'react-native';
import * as Network from 'expo-network';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function SettingsScreen() {
    const {
        mindMonitorLog, isMindMonitorActive, mindMonitorEnabled, setMindMonitorEnabled
    } = useMuseDevice();

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
                <View style={[s.infoRow, { borderBottomWidth: 0 }]}>
                    <View>
                        <Text style={s.infoKey}>RingConn 智能戒指</Text>
                        <Text style={{ fontSize: 10, color: '#555', marginTop: 4 }}>暂无相关戒指数据</Text>
                    </View>
                    <Text style={[s.infoVal, { color: '#888' }]}>暂不可用</Text>
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
