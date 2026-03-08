import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import TrackPlayer, { useProgress } from 'react-native-track-player';
import Slider from '@react-native-community/slider';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

const ProgressBar = () => {
    const { position, duration } = useProgress();
    const fmt = (sec: number) =>
        `${Math.floor(sec / 60)}:${Math.floor(sec % 60).toString().padStart(2, '0')}`;
    const pct = duration > 0 ? (position / duration) * 100 : 0;
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 8 }}>
            <Text style={s.timeText}>{fmt(position)}</Text>
            <Slider
                style={s.slider}
                minimumValue={0}
                maximumValue={duration > 0 ? duration : 1}
                value={position}
                minimumTrackTintColor="#3498DB"
                maximumTrackTintColor="#2A2D3A"
                thumbTintColor="#3498DB"
                onSlidingComplete={async (val) => {
                    await TrackPlayer.seekTo(val);
                }}
            />
            <Text style={[s.timeText, { textAlign: 'right' }]}>{fmt(duration)}</Text>
        </View>
    );
};

export default function MeditationPlayer() {
    const { musicName, pickAndPlay, togglePlay, isPlaying } = useMuseDevice();

    return (
        <View style={s.card}>
            <Text style={s.cardTitle}>🎵 冥想音乐</Text>
            <Text style={s.musicName}>{musicName}</Text>
            <View style={s.btnRow}>
                <TouchableOpacity style={s.btnPurple} onPress={pickAndPlay}>
                    <Text style={s.btnText}>选择音频</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.btnBlue, isPlaying && s.btnRed]} onPress={togglePlay}>
                    <Text style={s.btnText}>{isPlaying ? '⏸ 暂停' : '▶ 播放'}</Text>
                </TouchableOpacity>
            </View>
            <ProgressBar />
        </View>
    );
}

const s = StyleSheet.create({
    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
    musicName: { fontSize: 13, color: '#aaa', textAlign: 'center', marginBottom: 14 },
    btnRow: { flexDirection: 'row', justifyContent: 'center', gap: 12 },
    btnPurple: { backgroundColor: '#8E44AD', paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10 },
    btnBlue: { backgroundColor: '#3498DB', paddingVertical: 11, paddingHorizontal: 22, borderRadius: 10 },
    btnRed: { backgroundColor: '#E74C3C' },
    btnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    timeText: { color: '#888', fontSize: 11, width: 34 },
    slider: { flex: 1, height: 40 },
});
