import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

export default function SignalQualityCard() {
    const { signalLevel, signalScore, electrodeQuality, packetsRx } = useMuseDevice();

    const SIG = {
        good: { color: '#00E676', label: '信号良好 ✓', desc: '佩戴贴合 · 数据流畅通' },
        ok: { color: '#FFCA28', label: '信号一般 — 调整头环', desc: '请调整佩戴或等待数据流稳定' },
        poor: { color: '#FF5252', label: '信号差 — 重新佩戴', desc: '佩戴松动或数据中断' },
        none: { color: '#555', label: '未连接 / 等待数据', desc: '' },
    }[signalLevel] || { color: '#555', label: '未连接 / 等待数据', desc: '' };

    const dataFlowColor = packetsRx > 0 ? '#00E676' : '#FF5252';
    const dataFlowLabel = packetsRx > 0 ? '✓ 数据接收中' : '✗ 无数据';

    return (
        <View style={[s.sigCard, { borderColor: SIG.color }]}>
            <View style={{ gap: 6 }}>
                <View style={[s.sigDot, { backgroundColor: SIG.color }]} />
                <View style={s.horseshoe}>
                    {['TP9', 'AF7', 'AF8', 'TP10'].map(ch => (
                        <View key={ch} style={[
                            s.hsDot,
                            { backgroundColor: electrodeQuality[ch] >= 65 ? '#00E676' : electrodeQuality[ch] >= 35 ? '#FFCA28' : '#FF5252' }
                        ]} />
                    ))}
                </View>
            </View>
            <View style={{ flex: 1 }}>
                <Text style={[s.sigLabel, { color: SIG.color }]}>{SIG.label}</Text>
                {SIG.desc ? <Text style={s.sigDesc}>{SIG.desc}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    <Text style={{ fontSize: 10, color: '#777' }}>佩戴: {Object.values(electrodeQuality).filter(v => v >= 65).length}/4</Text>
                    <Text style={{ fontSize: 10, color: dataFlowColor }}>{dataFlowLabel}</Text>
                </View>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={[s.sigScore, { color: SIG.color }]}>{signalScore}%</Text>
                {packetsRx > 0 && (
                    <Text style={s.pktBadge}>
                        {packetsRx < 1000 ? `${packetsRx}包` : `${(packetsRx / 1000).toFixed(1)}k包`}
                    </Text>
                )}
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    sigCard: {
        flexDirection: 'row', alignItems: 'center', marginHorizontal: 20,
        marginBottom: 14, borderWidth: 1.5, borderRadius: 12,
        paddingVertical: 10, paddingHorizontal: 14, gap: 10,
        backgroundColor: '#1A1D27'
    },
    sigDot: { width: 10, height: 10, borderRadius: 5 },
    horseshoe: { flexDirection: 'row', gap: 3 },
    hsDot: { width: 6, height: 6, borderRadius: 3 },
    sigLabel: { fontSize: 13, fontWeight: '700' },
    sigDesc: { fontSize: 11, color: '#666', marginTop: 2 },
    sigScore: { fontSize: 18, fontWeight: '800' },
    pktBadge: {
        fontSize: 10, color: '#555', backgroundColor: '#0D0F14',
        paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10
    },
});
