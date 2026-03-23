import React, { useEffect, useState } from 'react';
import { View, Text, Modal, StyleSheet, Image, Button, ActivityIndicator, Alert } from 'react-native';
import ShareMenu from 'react-native-share-menu';

export const ShareReceiver = () => {
    const [sharedData, setSharedData] = useState<any>(null);
    const [isParsing, setIsParsing] = useState(false);

    const handleShare = (item: any) => {
        if (!item || (!item.data && !item.mimeType)) return;
        console.log('🔗 [ShareReceiver] 收到新分享内容:', item);
        setSharedData(item);
    };

    useEffect(() => {
        // App 被全家桶彻底杀掉，冷启动时
        ShareMenu.getInitialShare(handleShare);
        
        // App 在后台活着，从热启动恢复时
        const listener = ShareMenu.addNewShareListener(handleShare);
        return () => {
            listener.remove();
        };
    }, []);

    if (!sharedData) return null;

    // 分享进来的数据结构处理
    const mimeType = sharedData.mimeType || '';
    const isImage = mimeType?.startsWith('image/');
    let uri = Array.isArray(sharedData.data) ? sharedData.data[0] : sharedData.data;

    // 清理一下 URI 格式，部分文件系统前缀可能会不一样
    if (uri && uri.startsWith('content://')) {
        // content uri can be passed directly to Image component
    }

    const startAiProcess = () => {
        setIsParsing(true);
        // TODO: 之后接上了真正的 AI 视觉大模型后，将 uri 丢过去换 JSON 返回
        setTimeout(() => {
            setIsParsing(false);
            setSharedData(null);
            Alert.alert(
                '🎨 AI 研判成功 (演示测试)', 
                '✅ 睡眠时长: 8小时12分\n✅ 平均心率: 55 bpm\n✅ HRV均值: 62 ms\n\n之后这将自动存入本地数据库!',
                [{ text: '干得漂亮!' }]
            );
        }, 3000);
    };

    return (
        <Modal transparent={true} visible={!!sharedData} animationType="slide">
            <View style={styles.overlay}>
                <View style={styles.card}>
                    <Text style={styles.title}>收到一张睡眠截图 🌙</Text>
                    {isImage ? (
                        <Image source={{ uri }} style={styles.image} />
                    ) : (
                        <Text style={styles.text}>非图片数据: {JSON.stringify(sharedData.data)}</Text>
                    )}
                    
                    <View style={styles.buttonRow}>
                        <Button title="关闭取消" onPress={() => setSharedData(null)} color="#555" />
                        <View style={{width: 20}} />
                        <Button 
                            title={isParsing ? "正在调用大模型..." : "AI 提取数据"} 
                            onPress={startAiProcess} 
                            disabled={isParsing || (!isImage && !uri)} 
                            color="#8A33FF"
                        />
                    </View>
                    {isParsing && <ActivityIndicator style={{ marginTop: 25 }} color="#00E676" size="large" />}
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center' },
    card: { width: '85%', backgroundColor: '#1C1C1E', borderRadius: 16, padding: 25, alignItems: 'center' },
    title: { color: 'white', fontSize: 18, fontWeight: 'bold', marginBottom: 15 },
    text: { color: '#ccc', marginBottom: 15 },
    image: { width: 220, height: 420, resizeMode: 'contain', borderWidth: 1, borderColor: '#333', marginBottom: 25, borderRadius: 8 },
    buttonRow: { flexDirection: 'row', justifyContent: 'center', width: '100%', paddingHorizontal: 10 }
});
