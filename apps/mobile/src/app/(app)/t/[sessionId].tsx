import { isUuid } from "@kitty/core";
import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { StyleSheet, Text } from "react-native";
import { Card, Screen } from "../../../components/Screen";
import { colors, font } from "../../../theme";

/**
 * The table QR link (https://…/t/<session>?g=<group>) opened in the app. The app is for group members, so it opens
 * the bill inside its group; guests without an account keep using the web page the same link opens in a browser.
 */
export default function TableLink() {
  const { sessionId, g } = useLocalSearchParams<{ sessionId: string; g?: string }>();
  if (isUuid(sessionId) && isUuid(g)) return <Redirect href={`/groups/${g}/table/${sessionId}`} />;
  return (
    <Screen>
      <Stack.Screen options={{ title: "Split the bill" }} />
      <Card>
        <Text style={styles.body}>Open this bill from its group in Kitty, or open the link in your browser to join as a guest.</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({ body: { fontSize: font.base, color: colors.text } });
