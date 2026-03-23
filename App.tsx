import React from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { MuseDeviceProvider } from './src/contexts/MuseDeviceContext';
import AppNavigator from './src/navigation/AppNavigator';
import { StatusBar } from 'react-native';
import { RingConnProvider } from './src/contexts/RingConnContext';
import { ShareReceiver } from './src/components/ShareReceiver';

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
      <RingConnProvider>
        <NavigationContainer theme={DarkTheme}>
          <StatusBar barStyle="light-content" backgroundColor="#0D0F14" />
          <AppNavigator />
          <ShareReceiver />
        </NavigationContainer>
      </RingConnProvider>
    </MuseDeviceProvider>
  );
}
