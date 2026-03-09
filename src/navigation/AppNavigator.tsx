import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import HomeScreen from '../screens/HomeScreen';
import MeditationScreen from '../screens/MeditationScreen';
import SleepScreen from '../screens/SleepScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator();

export default function AppNavigator() {
    return (
        <Tab.Navigator
            screenOptions={{
                headerShown: false,
                tabBarStyle: {
                    backgroundColor: '#1A1D27',
                    borderTopColor: '#2A2D3A',
                    paddingBottom: 5,
                    paddingTop: 5,
                    height: 60,
                },
                tabBarActiveTintColor: '#3498DB',
                tabBarInactiveTintColor: '#888',
            }}
        >
            <Tab.Screen
                name="Home"
                component={HomeScreen}
                options={{ tabBarLabel: '首页', tabBarIcon: () => <Text style={{ fontSize: 20 }}>🏠</Text> }}
            />
            <Tab.Screen
                name="Meditation"
                component={MeditationScreen}
                options={{ tabBarLabel: '冥想', tabBarIcon: () => <Text style={{ fontSize: 20 }}>🧘</Text> }}
            />
            <Tab.Screen
                name="Sleep"
                component={SleepScreen}
                options={{ tabBarLabel: '分析', tabBarIcon: () => <Text style={{ fontSize: 20 }}>📊</Text> }}
            />
            <Tab.Screen
                name="Settings"
                component={SettingsScreen}
                options={{ tabBarLabel: '设置', tabBarIcon: () => <Text style={{ fontSize: 20 }}>⚙️</Text> }}
            />
        </Tab.Navigator>
    );
}
