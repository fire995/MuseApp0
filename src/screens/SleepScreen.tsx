import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';
import { Svg, Polyline, Line, Rect } from 'react-native-svg';

const { width } = Dimensions.get('window');

// ── 模拟图表组件 ──────────────────────────────────────
const MiniChart = ({ data, color, height = 80 }: { data: number[], color: string, height?: number }) => {
    if (!data || data.length === 0) return <View style={{ height, backgroundColor: '#12141D', borderRadius: 8 }} />;

    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = max - min;
    const points = data.map((v, i) => {
        const x = (i / (data.length - 1)) * (width - 72);
        const y = height - ((v - min) / range) * height;
        return `${x},${y}`;
    }).join(' ');

    return (
        <View style={{ height, marginTop: 10 }}>
            <Svg height={height} width={width - 72}>
                <Polyline
                    points={points}
                    fill="none"
                    stroke={color}
                    strokeWidth="2"
                    strokeLinecap="round"
                />
            </Svg>
        </View>
    );
};

export default function AnalysisScreen() {
    const { latestAnalysis } = useMuseDevice();
    const [activeTab, setActiveTab] = useState<'meditation' | 'nap' | 'sleep'>('meditation');

    const filteredResults = latestAnalysis?.type === activeTab ? latestAnalysis : null;

    const renderMetric = (label: string, value: string | number | null, unit: string) => (
        <View style={s.metricCard}>
            <Text style={s.metricLabel}>{label}</Text>
            <View style={s.metricValueRow}>
                <Text style={s.metricValue}>{value ?? '--'}</Text>
                <Text style={s.metricUnit}>{unit}</Text>
            </View>
        </View>
    );

    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 60 }}>
            <View style={s.header}>
                <Text style={s.title}>分析报告</Text>
            </View>

            {/* 水平二级菜单 */}
            <View style={s.tabBar}>
                {(['meditation', 'nap', 'sleep'] as const).map((t) => (
                    <TouchableOpacity
                        key={t}
                        style={[s.tabItem, activeTab === t && s.tabItemActive]}
                        onPress={() => setActiveTab(t)}
                    >
                        <Text style={[s.tabText, activeTab === t && s.tabTextActive]}>
                            {t === 'meditation' ? '🧘 冥想' : t === 'nap' ? '🌇 小睡' : '🌙 长夜'}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            <View style={s.content}>
                <Text style={s.sectionTitle}>最近会话数据</Text>

                {filteredResults ? (
                    <>
                        <View style={s.metricsGrid}>
                            {renderMetric('SOL 耗时', filteredResults.solMinutes, 'min')}
                            {renderMetric('T/A 峰值', filteredResults.peakThetaAlphaRatio.toFixed(2), 'ratio')}
                            {renderMetric('平均 RMSSD', filteredResults.avgRMSSD?.toFixed(1) ?? '--', 'ms')}
                        </View>

                        <View style={s.chartCard}>
                            <Text style={s.chartTitle}>Alpha-Theta 交叉趋势</Text>
                            <Text style={s.chartSub}>交叉次数: {filteredResults.crossoverPoints} 次</Text>
                            <MiniChart data={filteredResults.thetaAlphaSeries} color="#3498DB" />
                        </View>

                        <View style={s.chartCard}>
                            <Text style={s.chartTitle}>HRV (RMSSD) 趋势</Text>
                            <Text style={s.chartSub}>反映心脏自主神经系统状态</Text>
                            <MiniChart data={filteredResults.hrvSeries} color="#9B59B6" />
                        </View>
                    </>
                ) : (
                    <View style={s.emptyBox}>
                        <Text style={s.emptyText}>暂无该分类的会话记录</Text>
                        <Text style={s.emptySub}>结束一次{activeTab === 'meditation' ? '冥想' : '休息'}会话后数据将在此显示</Text>
                    </View>
                )}
            </View>
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: { paddingHorizontal: 20, paddingTop: 54, paddingBottom: 15 },
    title: { fontSize: 24, fontWeight: '800', color: '#EAEAEA' },

    tabBar: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        marginBottom: 20,
        gap: 10
    },
    tabItem: {
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        backgroundColor: '#1A1D27'
    },
    tabItemActive: {
        backgroundColor: '#3498DB22',
        borderWidth: 1,
        borderColor: '#3498DB'
    },
    tabText: { color: '#888', fontSize: 13, fontWeight: '600' },
    tabTextActive: { color: '#3498DB' },

    content: { paddingHorizontal: 20 },
    sectionTitle: { color: '#EAEAEA', fontSize: 16, fontWeight: '700', marginBottom: 15 },

    metricsGrid: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10,
        marginBottom: 20
    },
    metricCard: {
        flex: 1,
        backgroundColor: '#1A1D27',
        borderRadius: 12,
        padding: 12,
        alignItems: 'center'
    },
    metricLabel: { color: '#888', fontSize: 10, marginBottom: 4 },
    metricValueRow: { flexDirection: 'row', alignItems: 'baseline', gap: 2 },
    metricValue: { color: '#EAEAEA', fontSize: 18, fontWeight: '800' },
    metricUnit: { color: '#555', fontSize: 9 },

    chartCard: {
        backgroundColor: '#1A1D27',
        borderRadius: 16,
        padding: 16,
        marginBottom: 16
    },
    chartTitle: { color: '#EAEAEA', fontSize: 14, fontWeight: '700', marginBottom: 2 },
    chartSub: { color: '#555', fontSize: 11, marginBottom: 8 },

    emptyBox: {
        backgroundColor: '#1A1D27',
        borderRadius: 16,
        padding: 40,
        alignItems: 'center',
        borderStyle: 'dashed',
        borderWidth: 1,
        borderColor: '#333'
    },
    emptyText: { color: '#EAEAEA', fontSize: 15, fontWeight: '600', marginBottom: 8 },
    emptySub: { color: '#666', fontSize: 12, textAlign: 'center' }
});
