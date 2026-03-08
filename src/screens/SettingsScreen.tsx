import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import DataCaptureControl from '../components/DataCaptureControl';

export default function SettingsScreen() {
    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 48 }}>
            <View style={s.header}>
                <Text style={s.title}>设置与数据</Text>
            </View>

            <DataCaptureControl />
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: {
        paddingHorizontal: 20, paddingTop: 54, paddingBottom: 20
    },
    title: { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },
});
