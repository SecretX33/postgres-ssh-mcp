import { describe, it, expect } from "vitest";
import { validateReadOnlyQuery, ValidationError } from "./sql-validator.js";

describe("ValidationError", () => {
  it("is an instance of Error with a code property", () => {
    const err = new ValidationError("PARSE_ERROR", "bad sql");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PARSE_ERROR");
    expect(err.message).toBe("bad sql");
  });
});

describe("validateQuery – stub rejects empty string", () => {
  it("throws EMPTY_QUERY for empty input", async () => {
    await expect(validateReadOnlyQuery("")).rejects.toMatchObject({
      code: "EMPTY_QUERY",
    });
  });
});

describe("validateQuery – allowlist", () => {
  it("accepts a plain SELECT", async () => {
    await expect(validateReadOnlyQuery("SELECT 1")).resolves.toBeUndefined();
  });

  it("accepts EXPLAIN SELECT", async () => {
    await expect(
      validateReadOnlyQuery("EXPLAIN SELECT * FROM users"),
    ).resolves.toBeUndefined();
  });

  it("rejects INSERT", async () => {
    await expect(
      validateReadOnlyQuery("INSERT INTO t(x) VALUES (1)"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects UPDATE", async () => {
    await expect(validateReadOnlyQuery("UPDATE t SET x = 1")).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DELETE", async () => {
    await expect(validateReadOnlyQuery("DELETE FROM t")).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects CREATE TABLE", async () => {
    await expect(validateReadOnlyQuery("CREATE TABLE t (id INT)")).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects DROP TABLE", async () => {
    await expect(validateReadOnlyQuery("DROP TABLE t")).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });

  it("rejects TRUNCATE", async () => {
    await expect(validateReadOnlyQuery("TRUNCATE t")).rejects.toMatchObject({
      code: "FORBIDDEN_STATEMENT",
    });
  });
});

describe("validateQuery – EXPLAIN inner check", () => {
  it("rejects EXPLAIN DELETE", async () => {
    await expect(validateReadOnlyQuery("EXPLAIN DELETE FROM t")).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_TARGET",
    });
  });

  it("rejects EXPLAIN INSERT", async () => {
    await expect(
      validateReadOnlyQuery("EXPLAIN INSERT INTO t(x) VALUES (1)"),
    ).rejects.toMatchObject({ code: "FORBIDDEN_EXPLAIN_TARGET" });
  });

  it("rejects EXPLAIN UPDATE", async () => {
    await expect(
      validateReadOnlyQuery("EXPLAIN UPDATE t SET x = 1"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_EXPLAIN_TARGET",
    });
  });
});

describe("validateQuery – deep AST walk", () => {
  it("rejects mutating CTE (WITH … DELETE … SELECT)", async () => {
    await expect(
      validateReadOnlyQuery(
        `WITH deleted AS (DELETE FROM t RETURNING id)SELECT *FROM deleted`,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects mutating CTE (WITH … INSERT … SELECT)", async () => {
    await expect(
      validateReadOnlyQuery(
        `WITH ins AS (INSERT INTO t(x) VALUES (1) RETURNING id) SELECT * FROM ins`,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN_NESTED_MUTATION" });
  });

  it("rejects SELECT INTO", async () => {
    await expect(
      validateReadOnlyQuery("SELECT * INTO new_table FROM old_table"),
    ).rejects.toMatchObject({ code: "FORBIDDEN_SELECT_INTO" });
  });

  it("rejects SELECT FOR UPDATE", async () => {
    await expect(
      validateReadOnlyQuery("SELECT * FROM t FOR UPDATE"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_LOCKING",
    });
  });

  it("rejects SELECT FOR SHARE", async () => {
    await expect(
      validateReadOnlyQuery("SELECT * FROM t FOR SHARE"),
    ).rejects.toMatchObject({
      code: "FORBIDDEN_LOCKING",
    });
  });

  it("accepts a nested subquery SELECT (no mutation)", async () => {
    await expect(
      validateReadOnlyQuery("SELECT * FROM (SELECT id FROM t WHERE x > 1) sub"),
    ).resolves.toBeUndefined();
  });

  it("accepts a read-only CTE", async () => {
    await expect(
      validateReadOnlyQuery(`WITH cte AS (SELECT id FROM t)SELECT *FROM cte`),
    ).resolves.toBeUndefined();
  });
});
