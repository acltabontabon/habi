import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ProductCard } from "../components/ProductCard";

test("shows the add button", () => {
  render(<ProductCard name="Mug" price="€12" />);
  expect(screen.getByRole("button", { name: "Add to cart" })).toBeTruthy();
});
