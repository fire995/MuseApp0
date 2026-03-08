import React, { useState } from 'react';
import {
    View, Text, StyleSheet, ScrollView,
    Switch, TouchableOpacity, Alert, ActivityIndicator
} from 'react-native';
import DataCaptureControl from '../components/DataCaptureControl';
import { useMuseDevice } from '../contexts/MuseDeviceContext';

// 可选的自动保存间隔（秒）
const INTERVAL_OPTIONS: { label: string; value: number }[] = [
    { label: '30 秒', value: 30 },
    { label: '1 分钟', value: 60 },
    { label: '2 分钟', value: 120 },
    { label: '5 分钟', value: 300 },
];

// 可选的文件保留天数
const RETAIN_OPTIONS: { label: string; value: number }[] = [
    { label: '1 天', value: 1 },
    { label: '3 天', value: 3 },
    { label: '7 天', value: 7 },
    { label: '30 天', value: 30 },
];

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function SettingsScreen() {
    const {
        autoSaveEnabled, setAutoSaveEnabled,
        autoSaveIntervalSec, setAutoSaveIntervalSec,
        autoSaveRetainDays, setAutoSaveRetainDays,
        autoSaveTempSize, clearAutoSaveTempFiles,
    } = useMuseDevice();

    const [clearing, setClearing] = useState(false);

    const handleClear = () => {
        Alert.alert(
            '清空临时数据',
            `确定要删除所有本地临时保存的 EEG 数据文件（共 ${formatBytes(autoSaveTempSize)}）吗？\n\n⚠️ 此操作不可恢复，请先导出需要的文件。`,
            [
                { text: '取消', style: 'cancel' },
                {
                    text: '确认清除', style: 'destructive', onPress: async () => {
                        setClearing(true);
                        await clearAutoSaveTempFiles();
                        setClearing(false);
                        Alert.alert('✅ 已清空', '所有临时数据文件已删除。');
                    }
                },
            ]
        );
    };

    return (
        <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 60 }}>
            <View style={s.header}>
                <Text style={s.title}>设置与数据</Text>
            </View>

            {/* 采集控制 */}
            <DataCaptureControl />

            {/* ── 自动保存设置卡片 ── */}
            <View style={s.card}>
                {/* 标题行 + 主开关 */}
                <View style={s.cardTitleRow}>
                    <View>
                        <Text style={s.cardTitle}>🛡️ 自动防丢保存</Text>
                        <Text style={s.cardSub}>定时将内存缓冲写入磁盘，避免闪退丢失数据</Text>
                    </View>
                    <Switch
                        value={autoSaveEnabled}
                        onValueChange={setAutoSaveEnabled}
                        trackColor={{ false: '#2A2D3A', true: '#1E5C3A' }}
                        thumbColor={autoSaveEnabled ? '#4CAF50' : '#555'}
                    />
                </View>

                {autoSaveEnabled ? (
                    <>
                        {/* 状态徽章 */}
                        <View style={s.statusBadge}>
                            <Text style={s.statusDot}>●</Text>
                            <Text style={s.statusText}>
                                已开启 · 每 {autoSaveIntervalSec < 60
                                    ? `${autoSaveIntervalSec} 秒`
                                    : `${autoSaveIntervalSec / 60} 分钟`} 写盘一次
                            </Text>
                        </View>

                        {/* 写盘间隔 */}
                        <Text style={s.sectionLabel}>写盘频率</Text>
                        <View style={s.optRow}>
                            {INTERVAL_OPTIONS.map(opt => (
                                <TouchableOpacity
                                    key={opt.value}
                                    style={[s.optBtn, autoSaveIntervalSec === opt.value && s.optBtnOn]}
                                    onPress={() => setAutoSaveIntervalSec(opt.value)}>
                                    <Text style={[s.optText, autoSaveIntervalSec === opt.value && s.optTextOn]}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        <Text style={s.hint}>
                            ⚡ 间隔越短，丢失数据越少，但会更频繁地读写存储。推荐 1–2 分钟。
                        </Text>

                        {/* 文件保留天数 */}
                        <Text style={[s.sectionLabel, { marginTop: 14 }]}>文件保留时长</Text>
                        <View style={s.optRow}>
                            {RETAIN_OPTIONS.map(opt => (
                                <TouchableOpacity
                                    key={opt.value}
                                    style={[s.optBtn, autoSaveRetainDays === opt.value && s.optBtnOn]}
                                    onPress={() => setAutoSaveRetainDays(opt.value)}>
                                    <Text style={[s.optText, autoSaveRetainDays === opt.value && s.optTextOn]}>
                                        {opt.label}
                                    </Text>
                                </TouchableOpacity>
                            ))}
                        </View>
                        <Text style={s.hint}>
                            启动时自动清理超过该时间的旧 EEG 数据文件。
                        </Text>
                    </>
                ) : (
                    <View style={s.disabledBox}>
                        <Text style={s.disabledText}>
                            ⚠️ 已关闭自动保存。若程序闪退，当前采集周期内尚未写盘的数据将丢失。
                        </Text>
                    </View>
                )}
            </View>

            {/* ── 临时文件管理卡片 ── */}
            <View style={s.card}>
                <Text style={s.cardTitle}>📁 本地文件管理</Text>
                <Text style={s.cardSub}>临时保存路径：应用文档目录（DocumentDirectory）</Text>

                <View style={s.storageRow}>
                    <View style={s.storageInfo}>
                        <Text style={s.storageLabel}>当前占用</Text>
                        <Text style={s.storageValue}>{formatBytes(autoSaveTempSize)}</Text>
                    </View>
                    <View style={s.storageInfo}>
                        <Text style={s.storageLabel}>保留策略</Text>
                        <Text style={s.storageValue}>{autoSaveRetainDays} 天</Text>
                    </View>
                </View>

                <TouchableOpacity
                    style={[s.clearBtn, clearing && { opacity: 0.5 }]}
                    onPress={handleClear}
                    disabled={clearing || autoSaveTempSize === 0}>
                    {clearing
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <Text style={s.clearBtnText}>
                            {autoSaveTempSize === 0 ? '暂无临时文件' : '🗑️ 清空所有临时文件'}
                        </Text>
                    }
                </TouchableOpacity>

                <Text style={s.hint}>
                    💡 导出数据前请先使用上方的"导出数据文件"按钮将文件分享出去，再清空。
                </Text>
            </View>

            {/* ── 技术说明卡片 ── */}
            <View style={s.card}>
                <Text style={s.cardTitle}>ℹ️ 保存机制说明</Text>
                <View style={s.infoRow}>
                    <Text style={s.infoKey}>缓冲区刷写阈值</Text>
                    <Text style={s.infoVal}>64 KB（即触即写）</Text>
                </View>
                <View style={s.infoRow}>
                    <Text style={s.infoKey}>定时刷写</Text>
                    <Text style={s.infoVal}>{autoSaveEnabled
                        ? (autoSaveIntervalSec < 60 ? `${autoSaveIntervalSec}s` : `${autoSaveIntervalSec / 60}min`)
                        : '已关闭'}</Text>
                </View>
                <View style={s.infoRow}>
                    <Text style={s.infoKey}>App 后台时</Text>
                    <Text style={s.infoVal}>立即写盘</Text>
                </View>
                <View style={s.infoRow}>
                    <Text style={s.infoKey}>单文件分割</Text>
                    <Text style={s.infoVal}>5 MB → 新建 part 文件</Text>
                </View>
                <View style={s.infoRow}>
                    <Text style={s.infoKey}>文件格式</Text>
                    <Text style={s.infoVal}>.txt（Base64 原始包 + 元信息）</Text>
                </View>
                <View style={[s.infoRow, { borderBottomWidth: 0 }]}>
                    <Text style={s.infoKey}>文件命名</Text>
                    <Text style={s.infoVal}>muse_data_YYYY-MM-DDTHH-MM-SS.txt</Text>
                </View>
            </View>
        </ScrollView>
    );
}

const s = StyleSheet.create({
    root: { flex: 1, backgroundColor: '#0D0F14' },
    header: { paddingHorizontal: 20, paddingTop: 54, paddingBottom: 20 },
    title: { fontSize: 22, fontWeight: '700', color: '#EAEAEA' },

    card: {
        marginHorizontal: 20, marginBottom: 14, backgroundColor: '#1A1D27',
        borderRadius: 16, padding: 16
    },
    cardTitleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 },
    cardTitle: { fontSize: 14, color: '#EAEAEA', fontWeight: '700', marginBottom: 4 },
    cardSub: { fontSize: 11, color: '#555' },

    statusBadge: {
        flexDirection: 'row', alignItems: 'center', gap: 6,
        backgroundColor: '#0B1E14', borderRadius: 8, padding: 8, marginBottom: 14
    },
    statusDot: { color: '#4CAF50', fontSize: 10 },
    statusText: { color: '#4CAF50', fontSize: 12, fontWeight: '600' },

    sectionLabel: { fontSize: 12, color: '#888', marginBottom: 8, marginTop: 2 },
    optRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
    optBtn: {
        paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20,
        backgroundColor: '#2A2D3A', borderWidth: 1, borderColor: '#444'
    },
    optBtnOn: { backgroundColor: '#1E5C3A', borderColor: '#4CAF50' },
    optText: { color: '#aaa', fontSize: 12, fontWeight: '600' },
    optTextOn: { color: '#4CAF50' },
    hint: { fontSize: 10, color: '#444', lineHeight: 15, marginTop: 2 },

    disabledBox: {
        backgroundColor: '#1f1410', borderRadius: 8, padding: 10, marginTop: 4
    },
    disabledText: { fontSize: 12, color: '#B77A50', lineHeight: 18 },

    storageRow: { flexDirection: 'row', gap: 12, marginVertical: 12 },
    storageInfo: {
        flex: 1, backgroundColor: '#12141D', borderRadius: 10,
        padding: 12, alignItems: 'center'
    },
    storageLabel: { fontSize: 10, color: '#555', marginBottom: 4 },
    storageValue: { fontSize: 16, color: '#EAEAEA', fontWeight: '700' },

    clearBtn: {
        backgroundColor: '#5C1E1E', paddingVertical: 11, borderRadius: 10,
        alignItems: 'center', marginBottom: 8
    },
    clearBtnText: { color: '#E57373', fontWeight: '700', fontSize: 13 },

    infoRow: {
        flexDirection: 'row', justifyContent: 'space-between',
        paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#22253A'
    },
    infoKey: { fontSize: 12, color: '#666' },
    infoVal: { fontSize: 12, color: '#aaa', textAlign: 'right', flex: 1, marginLeft: 12 },
});
