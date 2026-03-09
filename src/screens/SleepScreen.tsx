import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function SleepScreen() {
    const { mindMonitorLog, isMindMonitorActive } = useMuseDevice();

    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>
            <View style={s.header}>
                <Text style={s.title}>睡眠分析</Text>
            </View>

            {/* 午休 - Data source: mind-monitor */}
            <View style={[s.placeholder, { marginBottom: 10 }]}>
                <Text style={s.placeholderTitle}>☀️ 午休分析 (Mind-Monitor OSC)</Text>
                <Text style={s.placeholderText}>连接 Mind-Monitor 获取午休脑波数据</Text>

                <View style={s.monitorArea}>
                    <Text style={[s.serverStatus,
                    isMindMonitorActive ? { color: '#4CAF50' } : { color: '#E57373' }
                    ]}>
                        {isMindMonitorActive ? '📡 OSC 服务正在监听 (Port: 5005)' : 'OSC 服务初始化中...'}
                    </Text>

                    <Text style={{ color: '#aaa', fontSize: 12, marginTop: 10, marginBottom: 5 }}>近期 OSC 消息(最新的在前):</Text>
                    {mindMonitorLog.length === 0 ? (
                        <Text style={{ color: '#555', fontSize: 11 }}>等待接收数据...</Text>
                    ) : (
                        mindMonitorLog.map((m, idx) => (
                            <Text key={idx} style={{ color: '#EAEAEA', fontSize: 10, fontFamily: 'monospace', marginBottom: 2 }}>{m}</Text>
                        ))
                    )}
                </View>
            </View>

            {/* 晚间 - RingConn */}
            <View style={s.placeholder}>
                <Text style={s.placeholderTitle}>🌙 晚间分析</Text>
                <Text style={s.placeholderText}>暂无 RingConn 设备数据，整晚长段睡眠分析占位</Text>
            </View>
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: {
        paddingHorizontal: 20, paddingTop: 54, paddingBottom: 20
    },
    title: { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },
    placeholder: {
        margin: 20,
        padding: 30,
        backgroundColor: '#1A1D27',
        borderRadius: 16,
        alignItems: 'flex-start',
    },
    placeholderTitle: {
        color: '#EAEAEA',
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 10
    },
    placeholderText: {
        color: '#888',
        fontSize: 13,
        marginBottom: 15
    },
    monitorArea: {
        backgroundColor: '#12141D',
        padding: 12,
        borderRadius: 8,
        width: '100%',
    },
    serverStatus: {
        fontSize: 13,
        fontWeight: 'bold',
    }
});
