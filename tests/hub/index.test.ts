import { afterAll, describe, expect, test } from "bun:test";
import { app } from "@/hub/index";

describe("hub server", () => {
  afterAll(() => {
    app.stop();
  });

  test("GET /health returns { status: 'ok' }", async () => {
    const port = app.server?.port;
    const response = await fetch(`http://localhost:${port}/health`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ status: "ok" });
  });
});
