import { formatMoney } from "@kitty/money";
import { Text, View } from "react-native";

export default function Home() {
  return (
    <View>
      <Text>Kitty</Text>
      <Text>{formatMoney(12345, "ZAR")}</Text>
    </View>
  );
}
