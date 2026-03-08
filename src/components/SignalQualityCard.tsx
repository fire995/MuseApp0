import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

/**
 * 信号质量卡片 — 参考 Mind Monitor HSI 及 BrainFlow 的多维度评估方式
 *
 * HSI 等级映射：
 *   score >= 65  → 良好 (Mind Monitor HSI = 1)
 *   score >= 35  → 一般 (Mind Monitor HSI = 2)
 *   score > 0    → 差   (Mind Monitor HSI = 4)
 *   score = 0    → 无信号
 */

// 信号等级配置（颜色 + 中文标签 + 描述 + 佩戴建议）
const SIGNAL_CONFIG = {
    good: {
        color: '#00E676',
        label: '信号良好 ✓',
        desc: '电极贴合 · 数据流畅',
        tip: '',
    },
    ok: {
        color: '#FFCA28',
        label: '信号一般 △',
        desc: '部分电极接触不佳',
        tip: '轻按耳后传感器 / 额头传感器',
    },
    poor: {
        color: '#FF5252',
        label: '信号差 ✗',
        desc: '电极接触不良',
        tip: '请重新调整头环佩戴',
    },
    none: {
        color: '#555',
        label: '等待信号…',
        desc: '未接收到数据',
        tip: '',
    },
};

// 电极通道位置标签（模拟 Mind Monitor horseshoe 布局）
const CHANNEL_LABELS: Record<string, string> = {
    TP9: '左耳',
    AF7: '左额',
    AF8: '右额',
    TP10: '右耳',
};

// 根据分数获取对应的 HSI 等级颜色和文字
function getChannelColor(score: number): string {
    if (score >= 65) return '#00E676';
    if (score >= 35) return '#FFCA28';
    if (score > 0) return '#FF5252';
    return '#333';
}

function getChannelLabel(score: number): string {
    if (score >= 65) return '良';
    if (score >= 35) return '中';
    if (score > 0) return '差';
    return '--';
}

export default function SignalQualityCard() {
    const { signalLevel, signalScore, electrodeQuality, packetsRx } = useMuseDevice();

    const SIG = SIGNAL_CONFIG[signalLevel] || SIGNAL_CONFIG.none;
    const channels = ['TP9', 'AF7', 'AF8', 'TP10'] as const;
    const goodCount = Object.values(electrodeQuality).filter(v => v >= 65).length;

    const dataFlowColor = packetsRx > 0 ? '#00E676' : '#FF5252';
    const dataFlowLabel = packetsRx > 0 ? '✓ 数据接收中' : '✗ 无数据';

    return (
        <View style={[s.sigCard, { borderColor: SIG.color }]}>
            {/* 左侧：信号指示灯 + Horseshoe 布局 */}
            <View style={{ gap: 8 }}>
                <View style={[s.sigDot, { backgroundColor: SIG.color }]} />
                {/* Horseshoe 电极布局（模拟 Mind Monitor 的 HSI 显示） */}
                <View style={s.horseshoe}>
                    {channels.map(ch => {
                        const score = electrodeQuality[ch] || 0;
                        const color = getChannelColor(score);
                        return (
                            <View key={ch} style={s.hsChannel}>
                                <View style={[s.hsDot, {
                                    backgroundColor: color,
                                    borderWidth: score > 0 ? 0 : 1,
                                    borderColor: '#444',
                                }]} />
                                <Text style={[s.hsLabel, { color }]}>
                                    {getChannelLabel(score)}
                                </Text>
                            </View>
                        );
                    })}
                </View>
            </View>

            {/* 中间：信号状态文字 */}
            <View style={{ flex: 1 }}>
                <Text style={[s.sigLabel, { color: SIG.color }]}>{SIG.label}</Text>
                {SIG.desc ? <Text style={s.sigDesc}>{SIG.desc}</Text> : null}
                {SIG.tip ? <Text style={s.sigTip}>💡 {SIG.tip}</Text> : null}
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
                    <Text style={{ fontSize: 10, color: '#777' }}>
                        佩戴: {goodCount}/4
                    </Text>
                    <Text style={{ fontSize: 10, color: dataFlowColor }}>
                        {dataFlowLabel}
                    </Text>
                </View>
            </View>

            {/* 右侧：分数 + 包计数 */}
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
                <Text style={[s.sigScore, { color: SIG.color }]}>
                    {signalScore}%
                </Text>
                {packetsRx > 0 && (
                    <Text style={s.pktBadge}>
                        {packetsRx < 1000
                            ? `${packetsRx}包`
                            : `${(packetsRx / 1000).toFixed(1)}k包`}
                    </Text>
                )}
            </View>
        </View>
    );
}

const s = StyleSheet.create({
    sigCard: {
        flexDirection: 'row',
        alignItems: 'center',
        marginHorizontal: 20,
        marginBottom: 14,
        borderWidth: 1.5,
        borderRadius: 12,
        paddingVertical: 10,
        paddingHorizontal: 14,
        gap: 10,
        backgroundColor: '#1A1D27',
    },
    sigDot: { width: 10, height: 10, borderRadius: 5 },
    horseshoe: { flexDirection: 'row', gap: 2 },
    hsChannel: { alignItems: 'center', gap: 1 },
    hsDot: { width: 8, height: 8, borderRadius: 4 },
    hsLabel: { fontSize: 7, fontWeight: '600' },
    sigLabel: { fontSize: 13, fontWeight: '700' },
    sigDesc: { fontSize: 11, color: '#666', marginTop: 2 },
    sigTip: { fontSize: 10, color: '#888', marginTop: 2, fontStyle: 'italic' },
    sigScore: { fontSize: 18, fontWeight: '800' },
    pktBadge: {
        fontSize: 10,
        color: '#555',
        backgroundColor: '#0D0F14',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 10,
    },
});
