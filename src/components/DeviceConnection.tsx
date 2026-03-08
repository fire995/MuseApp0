import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function DeviceConnection() {
    const { savedDeviceId, scanAndConnect, clearPairedDevice } = useMuseDevice();

    return (
        <View style={s.card}>
            <Text style={s.cardTitle}>📡 设备连接</Text>
            <TouchableOpacity style={s.actionBtn} onPress={scanAndConnect}>
                <Text style={s.btnText}>扫描并连接 Muse 头环</Text>
            </TouchableOpacity>
            {savedDeviceId && (
                <TouchableOpacity style={s.clearBtn} onPress={clearPairedDevice}>
                    <Text style={s.clearText}>
                        🔌 断开并清除配对：{savedDeviceId.substring(0, 14)}…
                    </Text>
                </TouchableOpacity>
            )}
        </View>
    );
}

const s = StyleSheet.create({
    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 10 },
    actionBtn: {
        backgroundColor: '#4A90E2', padding: 14, borderRadius: 12,
        alignItems: 'center', marginBottom: 10
    },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    clearBtn: { alignItems: 'center', paddingVertical: 8 },
    clearText: { color: '#FF6B6B', fontSize: 12 },
});
