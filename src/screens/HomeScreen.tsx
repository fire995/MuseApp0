import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function HomeScreen() {
    const { battery } = useMuseDevice();

    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>
            {/* 顶栏 */}
            <View style={s.header}>
                <Text style={s.title}>BCI 平台</Text>
                <View style={s.batteryWrap}>
                    <Text style={s.batteryText}>🔋 {battery}{typeof battery === 'number' ? '%' : ''}</Text>
                    {typeof battery === 'number' && (
                        <View style={[s.batteryBar, { width: Math.max(0, Math.min(100, battery)) * 0.28 }]} />
                    )}
                </View>
            </View>
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: {
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        paddingHorizontal: 20, paddingTop: 54, paddingBottom: 12
    },
    title: { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },
    batteryWrap: { alignItems: 'center', gap: 3 },
    batteryText: { color: '#aaa', fontSize: 12 },
    batteryBar: { height: 3, backgroundColor: '#00E676', borderRadius: 2 },
});
