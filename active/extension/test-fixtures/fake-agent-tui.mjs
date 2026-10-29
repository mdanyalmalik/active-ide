#!/usr/bin/env node
// Copyright (c) Active contributors. Licensed under the MIT License.
//
// TEST DOUBLE — NOT MUSE CODE. Imitates the sign-in output of Muse Code 1.4.14
// so Active's hidden sign-in driver can be tested in a real pseudo-terminal:
//   fake-agent-tui.mjs login   `muse login`: device code, "Press Enter to open it
//                              in your browser", then exits 0 when approved
//   fake-agent-tui.mjs         the interactive app: cursor position query, trust
//                              menu, then "Log in with browser" / "Set an API key"
// FAKE_TUI_OUTCOME=success|deny controls the result; FAKE_TUI_CRED_FILE, when
// set, is written on success.

import { writeFileSync } from 'node:fs';

const outcome = process.env.FAKE_TUI_OUTCOME ?? 'success';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = text => process.stdout.write(text);
if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
}
const nextInput = () => new Promise(resolve => process.stdin.once('data', data => resolve(String(data))));
const untilEnter = async () => {
	while (!(await nextInput()).includes('\r')) { /* keep reading */ }
};

async function approve() {
	write('Waiting for approval…\r\n');
	await sleep(800);
	if (outcome === 'deny') {
		write('Login was denied.\r\n');
		process.exit(1);
	}
	if (process.env.FAKE_TUI_CRED_FILE) {
		writeFileSync(process.env.FAKE_TUI_CRED_FILE, 'signed-in');
	}
	write('Logged in as tester@example.com\r\n');
}

const code = 'TEST-1234';
const url = `https://auth.meta.com/oauth/device/?code=${code}`;

if (process.argv[2] === 'login') {
	write(`Open this page to sign in:\r\n  ${url}\r\nconfirm this code matches:\r\n  ${code}\r\n\r\nPress Enter to open it in your browser:`);
	await untilEnter();
	write('\r\n');
	await approve();
	process.exit(0);
}

// Interactive app: like the real one, it draws nothing until the terminal answers its cursor query.
write('\x1b]10;?\x07\x1b[?25l\x1b[6n');
while (!(await nextInput()).includes('R')) { /* wait for the report */ }
write('\x1b[28;1H\x1b[1mDo you trust this workspace?\x1b[29;1HWorkspace:\x1b[30;1H' + process.cwd() + '\x1b[35;1H⟩ 1  Trust and continue\x1b[36;1H  2  Quit\x1b[38;1HUse Up/Down or 1/2, then Enter. Esc quits.');
await untilEnter();
write('\x1b[2J\x1b[1;1HMuse Code 1.4.14 (test double)\x1b[3;1HLog in with browser · Enter to choose\x1b[4;1HSet an API key\x1b[6;1H↓↑ to select · Esc to quit');
await untilEnter();
write(`\x1b[2J\x1b[1;1HRequesting a device login code…\x1b[3;1HSign in at\x1b[4;1Hthis page:\x1b[5;1H  ${url}\x1b[6;1Hconfirm this code matches:\x1b[7;1H  ${code}\x1b[9;1H`);
await approve();
write('> ');
process.stdin.on('data', data => {
	if (String(data).includes('\x03')) {
		process.exit(0);
	}
});
