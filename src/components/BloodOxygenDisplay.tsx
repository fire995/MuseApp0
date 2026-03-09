import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function BloodOxygenDisplay() {
    const { bloodOxygen } = useMuseDevice();

    return (
        <View style={[s.card, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}>
            <View>
                <Text style={s.cardTitle}>🩸 血氧饱和度 (SpO2)</Text>
                <Text style={{ fontSize: 11, color: '#555' }}>从 PPG 估算的血氧值</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
                <Text style={{
                    fontSize: 36, fontWeight: '800',
                    color: bloodOxygen ? '#00E676' : '#444',
                    letterSpacing: -1,
                }}>
                    {bloodOxygen ?? '--'}
                </Text>
                <Text style={{ fontSize: 12, color: '#555' }}>%</Text>
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
