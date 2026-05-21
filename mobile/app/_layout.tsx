import { Stack } from "expo-router";
import { StatusBar } from "react-native";

export default function RootLayout() {
  return (
    <>
      <StatusBar barStyle="light-content" backgroundColor="#0b0c10" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}
