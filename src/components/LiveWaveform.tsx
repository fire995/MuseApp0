import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

const SCREEN_W = Dimensions.get('window').width - 40;

const ThetaWave = React.memo(({ data }: { data: number[] }) => {
    const W = SCREEN_W - 32, H = 64, pad = 6;
    const pts = data.slice(-60);

    if (pts.length < 2 || pts.every(v => v === 0)) {
        return (
            <View style={[s.waveBox, { height: H, justifyContent: 'center', alignItems: 'center' }]}>
                <Text style={{ color: '#444', fontSize: 12 }}>等待数据…（连接头环后约 2 秒出现）</Text>
            </View>
        );
    }

    const mn = Math.min(...pts), mx = Math.max(...pts);
    const range = mx - mn || 1;
    const xs = pts.map((_, i) => pad + (i / (pts.length - 1)) * (W - pad * 2));
    const ys = pts.map(v => H - pad - ((v - mn) / range) * (H - pad * 2));

    return (
        <View style={[s.waveBox, { height: H, width: W }]}>
            {xs.map((x, i) => {
                if (i === 0) return null;
                const dx = x - xs[i - 1], dy = ys[i] - ys[i - 1];
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len < 0.5) return null;
                return (
                    <View key={i} style={{
                        position: 'absolute',
                        left: xs[i - 1] + dx / 2 - len / 2,
                        top: ys[i - 1] + dy / 2 - 1,
                        width: len, height: 2,
                        backgroundColor: '#00B894', borderRadius: 1,
                        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
                    }} />
                );
            })}
        </View>
    );
});

export default function LiveWaveform() {
    const { thetaWave, samplingMode } = useMuseDevice();

    return (
        <View style={s.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <Text style={s.cardTitle}>〜 Theta 脑波（4–8 Hz）</Text>
                <View style={[s.modePill, samplingMode === 'dense' ? s.modePillDense : s.modePillSparse]}>
                    <Text style={s.modePillText}>
                        {samplingMode === 'dense' ? '⚡ 高速' : '🌙 低功耗'}
                    </Text>
                </View>
            </View>
            <Text style={s.cardSub}>波形动起来 = 数据正在传输 ✓</Text>
            <ThetaWave data={thetaWave} />
        </View>
    );
}

const s = StyleSheet.create({
    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
    cardSub: { fontSize: 11, color: '#555', marginBottom: 10 },
    waveBox: { backgroundColor: '#0D0F14', borderRadius: 8, overflow: 'hidden' },
    modePill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10 },
    modePillDense: { backgroundColor: '#1a3a4a' },
    modePillSparse: { backgroundColor: '#1a2e1a' },
    modePillText: { fontSize: 10, color: '#aaa', fontWeight: '600' },
});
