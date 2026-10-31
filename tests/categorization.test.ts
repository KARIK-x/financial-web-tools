import { describe, expect, it } from "vitest";
import { inferCategoryCode } from "@/server/categorization";

describe("expense auto-categorization", () => {
  it("maps common merchant and description terms", () => {
    expect(inferCategoryCode("Finance Tracker scooter tyre")).toBe("OTHER");
    expect(inferCategoryCode("20 copies color print")).toBe("PRINTING");
    expect(inferCategoryCode("LED bulb and wire")).toBe("EQUIPMENT");
    expect(inferCategoryCode("taxi fare")).toBe("TRAVEL");
    expect(inferCategoryCode("lunch for volunteers")).toBe("FOOD");
    expect(inferCategoryCode("internet recharge")).toBe("UTILITIES");
  });
});
