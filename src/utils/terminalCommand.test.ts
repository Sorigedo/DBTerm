import test from 'node:test'
import assert from 'node:assert/strict'
import { commandsFromInputData, isRecordableShellCommand, stripShellPrompt, stripTerminalControls } from './terminalCommand.ts'

test('stripShellPrompt extracts actual command after shell prompt', () => {
  assert.equal(stripShellPrompt('[root@host ~]# docker ps'), 'docker ps')
  assert.equal(stripShellPrompt('charles@mac ~/repo % git status --short'), 'git status --short')
  assert.equal(stripShellPrompt('$ kubectl get pods -A'), 'kubectl get pods -A')
  assert.equal(stripShellPrompt('root@host:~#docker ps'), 'docker ps')
  assert.equal(stripShellPrompt('echo a > b'), 'echo a > b')
})

test('stripShellPrompt ignores ANSI decoration in prompt', () => {
  const line = '\x1b[32mroot@host\x1b[0m:\x1b[34m~\x1b[0m# systemctl status sshd'

  assert.equal(stripTerminalControls(line), 'root@host:~# systemctl status sshd')
  assert.equal(stripShellPrompt(line), 'systemctl status sshd')
})

test('commandsFromInputData records complete pasted commands only', () => {
  assert.deepEqual(commandsFromInputData('cd /tmp\nls -la\r'), ['cd /tmp', 'ls -la'])
  assert.deepEqual(commandsFromInputData('device'), [])
  assert.deepEqual(commandsFromInputData('\x1b[A\r'), [])
})

test('isRecordableShellCommand rejects empty/control-only values', () => {
  assert.equal(isRecordableShellCommand(''), false)
  assert.equal(isRecordableShellCommand('x'), false)
  assert.equal(isRecordableShellCommand('docker ps'), true)
})
