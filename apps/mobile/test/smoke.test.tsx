import { render, screen } from "@testing-library/react-native";
import { formatMoney } from "@kitty/money";
import Home from "../src/app/index";

test("the home screen renders money formatted by the shared package", async () => {
  await render(<Home />);
  expect(screen.getByText(formatMoney(12345, "ZAR"))).toBeTruthy();
});
