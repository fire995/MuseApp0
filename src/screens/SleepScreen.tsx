import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Dimensions, Alert } from 'react-native';
import { useMuseDevice } from '../contexts/MuseDeviceContext';
import { Svg, Polyline, Line, Rect } from 'react-native-svg';

const { width } = Dimensions.get('window');

const DualLineChart = ({ data1, data2, color1, color2, height = 80 }: { data1: number[], data2?: number[], color1: string, color2?: string, height?: number }) => {
    if (!data1 || data1.length === 0) return <View style={{ height, backgroundColor: '#12141D', borderRadius: 8 }} />;

    const max = Math.max(...data1, ...(data2 || []), 1);
    const min = Math.min(...data1, ...(data2 || []), 0);
    const range = max - min || 1;

    const generatePoints = (d: number[]) => d.map((v, i) => {
        const x = (i / (d.length - 1)) * (width - 72);
        const y = height - ((v - min) / range) * height;
        return `${x},${y}`;
    }).join(' ');

    const points1 = generatePoints(data1);
    const points2 = data2 ? generatePoints(data2) : '';

    return (
        <View style={{ height, marginTop: 10 }}>
            <Svg height={height} width={width - 72}>
                <Polyline points={points1} fill="none" stroke={color1} strokeWidth="2" strokeLinecap="round" />
                {data2 && <Polyline points={points2} fill="none" stroke={color2} strokeWidth="2" strokeLinecap="round" />}
            </Svg>
            {data2 && (
                <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 8, gap: 16 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 8, height: 8, backgroundColor: color1, borderRadius: 4 }} />
                        <Text style={{ color: '#888', fontSize: 10 }}>Theta (困倦)</Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <View style={{ width: 8, height: 8, backgroundColor: color2, borderRadius: 4 }} />
                        <Text style={{ color: '#888', fontSize: 10 }}>Alpha (清醒)</Text>
                    </View>
                </View>
            )}
        </View>
    );
};

export default function AnalysisScreen() {
    const { latestAnalysis, analysisHistory, clearAnalysisHistory, deleteHistoricalAnalysis } = useMuseDevice();
    const [activeTab, setActiveTab] = useState<'meditation' | 'nap' | 'sleep'>('meditation');
    const [selectedHistoryTs, setSelectedHistoryTs] = useState<number | null>(null);

    // Get the currently selected or latest results for the current tab
    const getDisplayedResults = () => {
        if (selectedHistoryTs) {
            const hist = analysisHistory.find(h => h.timestamp === selectedHistoryTs);
            if (hist && hist.type === activeTab) return hist;
        }
        return latestAnalysis?.type === activeTab ? latestAnalysis : null;
    };

    const filteredResults = getDisplayedResults();
    const historyList = analysisHistory.filter(h => h.type === activeTab);

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
                {historyList.length > 0 && (
                    <TouchableOpacity onPress={() => {
                        Alert.alert('清除历史', '确定要清除所有本地分析历史记录吗？', [
                            { text: '取消', style: 'cancel' },
                            { text: '确定清空', style: 'destructive', onPress: clearAnalysisHistory }
                        ]);
                    }}>
                        <Text style={{ color: '#E74C3C', fontSize: 12 }}>清空历史</Text>
                    </TouchableOpacity>
                )}
            </View>

            {/* 水平二级菜单 */}
            <View style={s.tabBar}>
                {(['meditation', 'nap', 'sleep'] as const).map((t) => (
                    <TouchableOpacity
                        key={t}
                        style={[s.tabItem, activeTab === t && s.tabItemActive]}
                        onPress={() => {
                            setActiveTab(t);
                            setSelectedHistoryTs(null); // 切换分类时取消选中特定历史
                        }}
                    >
                        <Text style={[s.tabText, activeTab === t && s.tabTextActive]}>
                            {t === 'meditation' ? '🧘 冥想' : t === 'nap' ? '🌇 小睡' : '🌙 长夜'}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            <View style={s.content}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 15 }}>
                    <Text style={[s.sectionTitle, { marginBottom: 0 }]}>
                        {selectedHistoryTs ? '历史会话数据' : '最近会话数据'}
                    </Text>
                    {selectedHistoryTs && (
                        <TouchableOpacity onPress={() => setSelectedHistoryTs(null)}>
                            <Text style={{ color: '#3498DB', fontSize: 13 }}>查看最新</Text>
                        </TouchableOpacity>
                    )}
                </View>

                {filteredResults ? (
                    filteredResults.thetaSeries.length === 0 && filteredResults.hrvSeries.length === 0 ? (
                        <View style={s.emptyBox}>
                            <Text style={s.emptyText}>数据量不足</Text>
                            <Text style={s.emptySub}>本次会话采样时间太短（仅 {filteredResults.durationSec.toFixed(1)}s），无法生成有效趋势图表。</Text>
                        </View>
                    ) : (
                        <>
                            <View style={s.metricsGrid}>
                                {renderMetric('SOL 耗时', filteredResults.solMinutes, 'min')}
                                {renderMetric('T/A 峰值', filteredResults.peakThetaAlphaRatio.toFixed(2), 'ratio')}
                                {renderMetric('平均 RMSSD', filteredResults.avgRMSSD?.toFixed(1) ?? '--', 'ms')}
                            </View>

                            <View style={s.chartCard}>
                                <Text style={s.chartTitle}>Alpha-Theta 交叉趋势</Text>
                                <Text style={s.chartSub}>交叉次数: {filteredResults.crossoverPoints} 次</Text>
                                <DualLineChart
                                    data1={filteredResults.thetaSeries}
                                    data2={filteredResults.alphaSeries}
                                    color1="#3498DB"
                                    color2="#E67E22"
                                />
                            </View>

                            <View style={s.chartCard}>
                                <Text style={s.chartTitle}>HRV (RMSSD) 趋势</Text>
                                <Text style={s.chartSub}>反映心脏自主神经系统状态</Text>
                                <DualLineChart data1={filteredResults.hrvSeries} color1="#9B59B6" />
                            </View>
                        </>
                    )
                ) : (
                    <View style={s.emptyBox}>
                        <Text style={s.emptyText}>暂无该分类的会话记录</Text>
                        <Text style={s.emptySub}>结束一次{activeTab === 'meditation' ? '冥想' : '休息'}会话后数据将在此显示</Text>
                    </View>
                )}

                {/* 历史记录列表 */}
                {historyList.length > 0 && (
                    <View style={{ marginTop: 30 }}>
                        <Text style={s.sectionTitle}>历史记录</Text>
                        {historyList.map(h => (
                            <TouchableOpacity
                                key={h.timestamp}
                                style={[
                                    s.historyItem,
                                    selectedHistoryTs === h.timestamp && s.historyItemActive
                                ]}
                                onPress={() => setSelectedHistoryTs(h.timestamp)}
                            >
                                <View style={{ flex: 1 }}>
                                    <Text style={s.historyTime}>
                                        {new Date(h.timestamp).toLocaleString()}
                                        {h.trackName ? ` • ${h.trackName}` : ''}
                                    </Text>
                                    <Text style={s.historyMetrics}>
                                        时长: {h.durationSec > 60 ? `${Math.floor(h.durationSec / 60)}分${h.durationSec % 60}秒` : `${h.durationSec.toFixed(1)}秒`} |
                                        {h.avgRMSSD ? ` RMSSD: ${h.avgRMSSD.toFixed(1)}ms` : ''}
                                    </Text>
                                </View>
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <TouchableOpacity
                                        style={{ padding: 8 }}
                                        onPress={() => {
                                            Alert.alert('删除记录', '确定要删除这条历史记录吗？', [
                                                { text: '取消', style: 'cancel' },
                                                { text: '删除', style: 'destructive', onPress: () => deleteHistoricalAnalysis(h.timestamp) }
                                            ]);
                                        }}
                                    >
                                        <Text style={{ fontSize: 16 }}>🗑️</Text>
                                    </TouchableOpacity>
                                </View>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}
            </View>
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: { paddingHorizontal: 20, paddingTop: 54, paddingBottom: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
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
    emptySub: { color: '#666', fontSize: 12, textAlign: 'center' },

    historyItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        backgroundColor: '#1A1D27',
        borderRadius: 12,
        padding: 14,
        marginBottom: 10,
    },
    historyItemActive: {
        borderWidth: 1,
        borderColor: '#3498DB',
        backgroundColor: '#3498DB11'
    },
    historyTime: {
        color: '#EAEAEA',
        fontSize: 14,
        fontWeight: '600',
        marginBottom: 4
    },
    historyMetrics: {
        color: '#888',
        fontSize: 11
    }
});
