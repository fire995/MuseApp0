import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, FlatList, Alert, Platform, PermissionsAndroid } from 'react-native';
import * as DocumentPicker from '@react-native-documents/picker';
// @ts-ignore
import * as FileSystem from 'expo-file-system/legacy';
import { useMuseDevice, MeditationTrack } from '../contexts/MuseDeviceContext';

export default function MeditationDatabase() {
    const {
        meditationTracks,
        addMeditationTrack,
        removeMeditationTrack,
        playMeditationTrack
    } = useMuseDevice();

    const [modalVisible, setModalVisible] = useState(false);
    const [tempUri, setTempUri] = useState('');
    const [trackName, setTrackName] = useState('');

    const handlePickFile = async () => {
        try {
            if (Platform.OS === 'android') {
                // @ts-ignore
                if (Platform.Version >= 33) {
                    await PermissionsAndroid.request('android.permission.READ_MEDIA_AUDIO' as any);
                } else {
                    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE);
                }
            }

            const results = await DocumentPicker.pick({
                type: [DocumentPicker.types.audio],
                mode: 'import'
            });
            if (results?.length > 0) {
                const res = results[0];
                let finalUri = res.uri;

                try {
                    const copies = await DocumentPicker.keepLocalCopy({
                        files: [{ uri: res.uri, fileName: res.name || `track_${Date.now()}.mp3` }],
                        destination: 'documentDirectory'
                    });
                    if (copies[0].status === 'success') {
                        finalUri = copies[0].localUri;
                    } else if (copies[0].status === 'error') {
                        throw new Error(copies[0].copyError || 'error');
                    }
                } catch (copyErr) {
                    if (finalUri.startsWith('content://')) {
                        try {
                            const persistentUri = `${FileSystem.documentDirectory}${res.name || `track_${Date.now()}.mp3`}`;
                            await FileSystem.copyAsync({ from: res.uri, to: persistentUri });
                            finalUri = persistentUri;
                        } catch (e) {
                            console.error(e);
                        }
                    }
                }

                if (finalUri.startsWith('content://')) {
                    Alert.alert('选择失败', '无法将文件复制到应用本地目录，请尝试将文件移动到其它文件夹再选择。');
                    return;
                }

                setTempUri(finalUri);
                setTrackName(res.name || '');
                setModalVisible(true);
            }
        } catch (err: any) {
            if (DocumentPicker.isErrorWithCode(err) && err.code === DocumentPicker.errorCodes.OPERATION_CANCELED) {
                // cancelled
            } else {
                console.error(err);
                Alert.alert('错误', '无法访问音频文件');
            }
        }
    };

    const handleSaveTrack = async () => {
        if (!trackName.trim()) {
            Alert.alert('提示', '请输入音乐名称');
            return;
        }
        await addMeditationTrack(trackName, tempUri);
        setModalVisible(false);
        setTrackName('');
        setTempUri('');
    };

    const renderTrackItem = ({ item }: { item: MeditationTrack }) => (
        <View style={s.trackItem}>
            <TouchableOpacity
                style={s.trackInfo}
                onPress={() => playMeditationTrack(item.id)}
            >
                <Text style={s.trackName}>{item.name}</Text>
                <Text style={s.trackId}>ID: {item.id}</Text>
            </TouchableOpacity>
            <TouchableOpacity
                style={s.deleteBtn}
                onPress={() => {
                    Alert.alert('确认', `确定要从数据库中移除 "${item.name}" 吗？`, [
                        { text: '取消', style: 'cancel' },
                        { text: '确定', style: 'destructive', onPress: () => removeMeditationTrack(item.id) }
                    ]);
                }}
            >
                <Text style={s.deleteText}>🗑️</Text>
            </TouchableOpacity>
        </View>
    );

    return (
        <View style={s.container}>
            <View style={s.header}>
                <Text style={s.title}>🗂️ 冥想音乐数据库</Text>
                <TouchableOpacity style={s.uploadBtn} onPress={handlePickFile}>
                    <Text style={s.uploadBtnText}>＋ 上传音乐</Text>
                </TouchableOpacity>
            </View>

            {meditationTracks.length === 0 ? (
                <View style={s.emptyBox}>
                    <Text style={s.emptyText}>数据库空空如也{'\n'}点击右上角上传本地音乐</Text>
                </View>
            ) : (
                <FlatList
                    data={meditationTracks}
                    renderItem={renderTrackItem}
                    keyExtractor={item => item.id}
                    scrollEnabled={false} // Nested in ScrollView
                />
            )}

            {/* 编辑框 Modal */}
            <Modal
                animationType="fade"
                transparent={true}
                visible={modalVisible}
                onRequestClose={() => setModalVisible(false)}
            >
                <View style={s.modalOverlay}>
                    <View style={s.modalContent}>
                        <Text style={s.modalTitle}>新建播放源</Text>

                        <Text style={s.label}>音乐名称</Text>
                        <TextInput
                            style={s.input}
                            value={trackName}
                            onChangeText={setTrackName}
                            placeholder="输入音乐显示名称"
                            placeholderTextColor="#555"
                        />

                        <Text style={s.label}>播放源地址</Text>
                        <Text style={s.uriPreview} numberOfLines={2}>{tempUri}</Text>

                        <View style={s.modalButtons}>
                            <TouchableOpacity
                                style={[s.mBtn, s.mBtnCancel]}
                                onPress={() => setModalVisible(false)}
                            >
                                <Text style={s.mBtnText}>取消</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={[s.mBtn, s.mBtnSave]}
                                onPress={handleSaveTrack}
                            >
                                <Text style={s.mBtnText}>确认并写入数据库</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const s = StyleSheet.create({
    container: {
        marginHorizontal: 20,
        marginBottom: 20,
        backgroundColor: '#1A1D27',
        borderRadius: 16,
        padding: 16,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 16,
    },
    title: {
        fontSize: 14,
        color: '#EAEAEA',
        fontWeight: '700',
    },
    uploadBtn: {
        backgroundColor: '#2A7DB5',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
    },
    uploadBtnText: {
        color: '#fff',
        fontSize: 12,
        fontWeight: '600',
    },
    emptyBox: {
        padding: 30,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyText: {
        color: '#555',
        fontSize: 13,
        textAlign: 'center',
        lineHeight: 20,
    },
    trackItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#22253A',
    },
    trackInfo: {
        flex: 1,
    },
    trackName: {
        color: '#EAEAEA',
        fontSize: 14,
        fontWeight: '600',
        marginBottom: 2,
    },
    trackId: {
        color: '#555',
        fontSize: 10,
        fontFamily: 'monospace',
    },
    deleteBtn: {
        padding: 8,
    },
    deleteText: {
        fontSize: 16,
    },
    // Modal Styles
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.8)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalContent: {
        width: '85%',
        backgroundColor: '#1A1D27',
        borderRadius: 20,
        padding: 20,
        borderWidth: 1,
        borderColor: '#333',
    },
    modalTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: '#EAEAEA',
        marginBottom: 20,
        textAlign: 'center',
    },
    label: {
        color: '#888',
        fontSize: 12,
        marginBottom: 8,
    },
    input: {
        backgroundColor: '#0D0F14',
        borderRadius: 10,
        padding: 12,
        color: '#EAEAEA',
        fontSize: 14,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: '#333',
    },
    uriPreview: {
        color: '#444',
        fontSize: 10,
        marginBottom: 24,
    },
    modalButtons: {
        flexDirection: 'row',
        gap: 12,
    },
    mBtn: {
        flex: 1,
        paddingVertical: 12,
        borderRadius: 10,
        alignItems: 'center',
    },
    mBtnCancel: {
        backgroundColor: '#2A2D3A',
    },
    mBtnSave: {
        backgroundColor: '#3498DB',
    },
    mBtnText: {
        color: '#fff',
        fontWeight: '700',
        fontSize: 14,
    },
});
