const t = process.argv[2];
const runId = process.argv[3];
fetch("https://api.github.com/repos/DarkAlucard007/player-ios/actions/runs/" + runId + "/jobs", {
  headers: { Authorization: "Bearer " + t }
}).then(r => r.json()).then(j => {
  const job = (j.jobs || []).find(x => x.conclusion === "failure");
  if (!job) { console.log("no failing job"); return; }
  console.log("FAILED_STEP=" + job.steps.filter(s => s.conclusion === "failure").map(s => s.name).join(", "));
  return fetch("https://api.github.com/repos/DarkAlucard007/player-ios/actions/jobs/" + job.id + "/logs", {
    headers: { Authorization: "Bearer " + t }
  }).then(r => r.text());
}).then(t2 => {
  if (!t2) return;
  const lines = t2.split("\n");
  // print the FFmpeg compile step's tail (last 60 lines containing error/configure/make)
  const errs = lines.filter(l => /error:|Error |fatal|undefined reference|No such file|not found|configure: error|make: \*\*\*/.test(l));
  console.log("TOTAL_ERRLINES=" + errs.length);
  errs.slice(-40).forEach(l => console.log(l.slice(0, 300)));
}).catch(e => console.log("ERR " + e.message));
