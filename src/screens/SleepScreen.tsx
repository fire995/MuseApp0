import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

export default function SleepScreen() {
    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>
            <View style={s.header}>
                <Text style={s.title}>睡眠分析</Text>
            </View>

            <View style={s.placeholder}>
                <Text style={s.placeholderTitle}>🌙 睡眠分期分析准备中</Text>
                <Text style={s.placeholderText}>将基于 Delta、Theta 脑波绘制深睡/浅睡结构图</Text>
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
        alignItems: 'center',
    },
    placeholderTitle: {
        color: '#EAEAEA',
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 10
    },
    placeholderText: {
        color: '#888',
        textAlign: 'center',
        fontSize: 13
    }
});
