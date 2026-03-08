import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function HeartRateDisplay() {
    const { heartRate } = useMuseDevice();

    return (
        <View style={[s.card, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
            <View>
                <Text style={s.cardTitle}>❤️ 实时心率</Text>
                <Text style={{ fontSize: 11, color: '#555' }}>PPG 峰值检测（需 3 秒以上 PPG 数据）</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
                <Text style={{
                    fontSize: 36, fontWeight: '800',
                    color: heartRate ? '#FF6B6B' : '#444',
                    letterSpacing: -1,
                }}>
                    {heartRate ?? '--'}
                </Text>
                <Text style={{ fontSize: 12, color: '#555' }}>BPM</Text>
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
});
