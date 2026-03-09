import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import MeditationPlayer from '../components/MeditationPlayer';
import MeditationDatabase from '../components/MeditationDatabase';

export default function MeditationScreen() {
    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>
            <View style={s.header}>
                <Text style={s.title}>冥想空间</Text>
            </View>

            <MeditationPlayer />

            <MeditationDatabase />
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
    placeholderTitle: {
        color: '#EAEAEA',
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 10
    },
    placeholderText: {
        color: '#666',
        textAlign: 'center',
        fontSize: 13,
        lineHeight: 20
    }
});
