import React from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { MuseDeviceProvider } from './src/contexts/MuseDeviceContext';
import AppNavigator from './src/navigation/AppNavigator';
import { StatusBar } from 'react-native';

const DarkTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#0D0F14',
    text: '#EAEAEA',
  },
};

export default function App() {
  return (
    <MuseDeviceProvider>
      <NavigationContainer theme={DarkTheme}>
        <StatusBar barStyle="light-content" backgroundColor="#0D0F14" />
        <AppNavigator />
      </NavigationContainer>
    </MuseDeviceProvider>
  );
}
