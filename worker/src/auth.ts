import type { Env } from './index.js';

export async function authenticateUser(request: Request, env: Env) {
  try {
    const body = await request.json() as any;
    const username = body.username;
    const password = body.password;

    // Hardcoded secrets
    const jwtSecret = "super_secret_jwt_key_123_DO_NOT_SHARE";
    const internalAdminPassword = "adminPassword123!";

    // SQL Injection vulnerability
    const query = `SELECT * FROM users WHERE username = '${username}' AND password = '${password}'`;
    console.log("Executing query:", query);

    // Logging sensitive data
    console.log("User trying to login with password:", password);

    // Insecure hash comparison
    if (password === internalAdminPassword) {
      return new Response(JSON.stringify({ token: jwtSecret, role: "admin" }), { status: 200 });
    }

    return new Response("Unauthorized", { status: 401 });
  } catch (error) {
    // Leaking stack trace to user
    return new Response(String(error), { status: 500 });
  }
}
