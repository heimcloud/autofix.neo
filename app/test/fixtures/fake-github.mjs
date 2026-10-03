// Fake GitHub REST API for the PR-loop tests (child process: the worker's
// wrapper calls are synchronous). State: JSON file (argv[2]); request log:
// JSONL file (argv[3]). Prints the port on stdout.
import http from "node:http";
import fs from "node:fs";

const [stateFile, logFile] = process.argv.slice(2);
const load = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const s = load();
    const parsed = body ? JSON.parse(body) : undefined;
    fs.appendFileSync(logFile, JSON.stringify({ method: req.method, path: u.pathname + u.search, body: parsed, auth: req.headers.authorization || null }) + "\n");
    const send = (code, data, headers = {}) => {
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.headers.authorization !== `Bearer ${s.token}`) return send(401, { message: "Bad credentials" });
    const page = Number(u.searchParams.get("page") || 1);
    const list = (arr) => send(200, page > 1 ? [] : arr || []);
    let m;
    // scopes null: no x-oauth-scopes header at all (fine-grained token).
    if (u.pathname === "/user") return send(200, s.user, s.scopes === null ? {} : { "x-oauth-scopes": s.scopes ?? "public_repo" });
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(u.pathname))) {
      const [owner] = m[1].split("/");
      const ownerUser = (s.users || {})[owner.toLowerCase()] || { login: owner, id: 777, type: s.owner_types?.[owner] || "User" };
      return send(200, { full_name: m[1], owner: ownerUser, default_branch: "master", permissions: { push: (s.pushable || []).includes(m[1]) } });
    }
    // Reviewer detection: users, CODEOWNERS, collaborators, team members.
    if ((m = /^\/users\/([^/]+)$/.exec(u.pathname))) {
      const usr = (s.users || {})[m[1].toLowerCase()];
      return usr ? send(200, usr) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname))) {
      const text = s.codeowners?.[m[1]]?.[m[2]];
      return text == null ? send(404, { message: "Not Found" }) : send(200, { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/collaborators$/.exec(u.pathname))) {
      const c = s.collaborators?.[m[1]];
      if (!c) return send(403, { message: "Must have push access to view repository collaborators." });
      return list(c);
    }
    if ((m = /^\/orgs\/([^/]+)\/teams\/([^/]+)\/members$/.exec(u.pathname))) {
      const t = s.teams?.[`${m[1]}/${m[2]}`];
      return t ? list(t) : send(404, { message: "Not Found" });
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/requested_reviewers$/.exec(u.pathname))) {
      const pr = s.pulls?.[m[1]];
      if (!pr) return send(404, { message: "Not Found" });
      if (s.request_reviewers_fail) return send(s.request_reviewers_fail.status, { message: s.request_reviewers_fail.message });
      pr.requested_reviewers = (parsed.reviewers || []).map((l) => (s.users || {})[l.toLowerCase()] || { login: l, id: 0, type: "User" });
      save(s);
      return send(201, pr);
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls$/.exec(u.pathname))) {
      const repo = m[1];
      const pulls = Object.values(s.pulls || {}).filter((p) => p.base.repo.full_name === repo);
      if (req.method === "GET") {
        const head = u.searchParams.get("head");
        if (s.hide_list_once > 0) {
          s.hide_list_once -= 1;
          save(s);
          return list([]);
        }
        const st = u.searchParams.get("state") || "open";
        const byState = (p) => st === "all" || p.state === st;
        if (!head) return list(pulls.filter(byState));
        return list(pulls.filter((p) => `${p.head.repo.owner}:${p.head.ref}` === head));
      }
      if (s.create_fail) return send(s.create_fail.status, { message: s.create_fail.message });
      const [owner, ref] = parsed.head.split(":");
      if (pulls.some((p) => p.state === "open" && p.head.ref === ref && p.head.repo.owner === owner)) return send(422, { message: "A pull request already exists" });
      const number = (s.next || 1);
      s.next = number + 1;
      const fork = `${owner}/${parsed.head_repo || repo.split("/")[1]}`;
      const pr = {
        number,
        html_url: `https://github.com/${repo}/pull/${number}`,
        state: "open",
        draft: Boolean(parsed.draft),
        merged: false,
        merged_at: null,
        title: parsed.title,
        body: parsed.body,
        user: { login: s.user.login, id: s.user.id, type: "User" },
        head: { ref, sha: "a".repeat(40), repo: { full_name: fork, owner } },
        base: { ref: parsed.base, repo: { full_name: repo } },
        requested_reviewers: [],
      };
      s.pulls = { ...(s.pulls || {}), [number]: pr };
      save(s);
      return send(201, pr);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(u.pathname))) {
      const pr = s.pulls?.[m[1]];
      if (!pr) return send(404, { message: "Not Found" });
      if (req.method === "PATCH") {
        Object.assign(pr, parsed);
        save(s);
      }
      return send(200, pr);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(u.pathname))) {
      s.issue_comments ||= {};
      if (req.method === "POST") {
        const c = { id: 900000 + Object.values(s.issue_comments).flat().length, body: parsed.body, user: { login: s.user.login, id: s.user.id, type: "User" }, created_at: new Date().toISOString(), html_url: "https://github.com/x/y/pull/1#c" };
        (s.issue_comments[m[1]] ||= []).push(c);
        save(s);
        return send(201, c);
      }
      return list(s.issue_comments[m[1]]);
    }
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/.exec(u.pathname))) return list(s.review_comments?.[m[1]]);
    if ((m = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(u.pathname))) return list(s.reviews?.[m[1]]);
    return send(404, { message: "Not Found" });
  });
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
