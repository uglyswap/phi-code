---
description: "Test strategy, unit tests, integration tests, and test automation"
---
# Testing Skill

## When to use
Writing tests, designing test strategies, debugging test failures.

## Test Pyramid
1. **Unit tests** (70%) — Fast, isolated, test single functions
2. **Integration tests** (20%) — Test component interactions
3. **E2E tests** (10%) — Test full user flows

## Best Practices
- Test behavior, not implementation details
- One assertion per test (ideally)
- Arrange → Act → Assert pattern
- Use descriptive test names: `should return 404 when user not found`
- Mock external dependencies, not internal logic
- Test edge cases: empty, null, boundary values, errors
- Don't test library code

## TypeScript (Vitest/Jest)
```typescript
describe("UserService", () => {
  it("should create a user with valid data", async () => {
    const user = await createUser({ name: "Test", email: "test@example.com" });
    expect(user.id).toBeDefined();
    expect(user.name).toBe("Test");
  });

  it("should throw on duplicate email", async () => {
    await createUser({ name: "A", email: "dup@example.com" });
    await expect(createUser({ name: "B", email: "dup@example.com" }))
      .rejects.toThrow("Email already exists");
  });
});
```

## Test Coverage
- Aim for 80%+ on critical paths
- 100% on business logic
- Don't chase 100% everywhere (diminishing returns)
