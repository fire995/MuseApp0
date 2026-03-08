import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import MeditationPlayer from '../components/MeditationPlayer';

export default function MeditationScreen() {
    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>
            <View style={s.header}>
                <Text style={s.title}>冥想空间</Text>
            </View>

            <MeditationPlayer />

            <View style={s.placeholder}>
                <Text style={s.placeholderText}>按需求保留页面结构{'\n'}更多冥想引导和放松内容即将上线</Text>
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
        borderStyle: 'dashed',
        borderWidth: 1,
        borderColor: '#333'
    },
    placeholderText: {
        color: '#666',
        textAlign: 'center',
        lineHeight: 24
    }
});
