import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function HRVDisplay() {
    const { hrv } = useMuseDevice();

    return (
        <View style={[s.card, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
            <View>
                <Text style={s.cardTitle}>💓 心率变异性 (HRV)</Text>
                <Text style={{ fontSize: 11, color: '#555' }}>反映身体抗压疲劳状态</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
                <Text style={{
                    fontSize: 36, fontWeight: '800',
                    color: hrv ? '#6C5CE7' : '#444',
                    letterSpacing: -1,
                }}>
                    {hrv ?? '--'}
                </Text>
                <Text style={{ fontSize: 12, color: '#555' }}>ms</Text>
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
