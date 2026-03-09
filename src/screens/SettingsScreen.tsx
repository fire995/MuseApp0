import React, { useEffect, useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView
} from 'react-native';
import * as Network from 'expo-network';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function SettingsScreen() {
    const {
        mindMonitorLog, isMindMonitorActive,
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
                <Text style={s.cardTitle}>🔗 设备连接情况</Text>

                {/* Mind-Monitor 连接状态 */}
                <View style={[s.infoRow, { borderBottomWidth: 1, paddingBottom: 12, marginBottom: 12 }]}>
                    <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                            <Text style={s.infoKey}>Mind-Monitor (OSC/UDP)</Text>
                        </View>
                        <View style={{ marginBottom: 6, backgroundColor: '#111', padding: 6, borderRadius: 4 }}>
                            <Text style={{ fontSize: 10, color: '#4CAF50' }}>[请核对] OSC Stream Target IP: {localIp}</Text>
                        </View>
                        <View>
                            {mindMonitorLog.length === 0 ? (
                                <Text style={{ fontSize: 10, color: '#444' }}>等待接收本地网络数据包...</Text>
                            ) : (
                                mindMonitorLog.slice(0, 5).map((log, i) => (
                                    <Text key={i} style={{ fontSize: 9, color: '#555', fontFamily: 'monospace' }}>{log}</Text>
                                ))
                            )}
                        </View>
                    </View>
                    <View style={{ alignItems: 'flex-end', marginLeft: 10 }}>
                        <Text style={[s.infoVal, { color: isMindMonitorActive ? '#4CAF50' : '#888' }]}>
                            {isMindMonitorActive ? '📡 监听中' : '未连接'}
                        </Text>
                        <Text style={{ fontSize: 9, color: '#333', marginTop: 4 }}>Port: 5005</Text>
                    </View>
                </View>

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
    cardTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
    cardSub: { fontSize: 11, color: '#555' },

    infoRow: {
        flexDirection: 'row', justifyContent: 'space-between',
        paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#22253A'
    },
    infoKey: { fontSize: 12, color: '#666' },
    infoVal: { fontSize: 12, color: '#aaa', textAlign: 'right', flex: 1, marginLeft: 12 },
});
