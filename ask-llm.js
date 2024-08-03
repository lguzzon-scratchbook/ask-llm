#!/usr/bin/env node

const readline = require('node:readline');
const https = require('node:https');

const LLM_API_BASE_URL
	= process.env.LLM_API_BASE_URL || 'https://api.openai.com/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL;
const LLM_STREAMING = process.env.LLM_STREAMING !== 'no';
const LLM_DEBUG = process.env.LLM_DEBUG;

// Cache for API responses
const responseCache = new Map();

// Reusable HTTPS agent for connection pooling
const httpsAgent = new https.Agent({keepAlive: true});

const chat = async (messages, handler) => {
	const url = new URL(`${LLM_API_BASE_URL}/chat/completions`);
	const headers = {
		'Content-Type': 'application/json',
		...(LLM_API_KEY && {Authorization: `Bearer ${LLM_API_KEY}`}),
	};
	const body = JSON.stringify({
		messages,
		model: LLM_CHAT_MODEL || 'gpt-4o-mini',
		stop: ['<|im_end|>', '<|end|>', '<|eot_id|>'],
		max_tokens: 200,
		temperature: 0,
		stream: LLM_STREAMING && typeof handler === 'function',
	});

	// Check cache for non-streaming requests
	if (!LLM_STREAMING) {
		const cacheKey = JSON.stringify(messages);
		if (responseCache.has(cacheKey)) {
			return responseCache.get(cacheKey);
		}
	}

	return new Promise((resolve, reject) => {
		const request = https.request(
			url,
			{
				method: 'POST',
				headers,
				agent: httpsAgent,
			},
			res => {
				if (res.statusCode !== 200) {
					reject(
						new Error(`HTTP error: ${res.statusCode} ${res.statusMessage}`),
					);
					return;
				}

				let answer = '';
				const handleData = LLM_STREAMING
					? handleStreamingData
					: handleNonStreamingData;

				res.on('data', chunk =>
					handleData(chunk, handler, partial => {
						answer += partial;
					}),
				);

				res.on('end', () => {
					if (!LLM_STREAMING) {
						responseCache.set(JSON.stringify(messages), answer);
					}

					resolve(answer.trim());
				});
			},
		);

		request.on('error', reject);
		request.write(body);
		request.end();
	});
};

const handleStreamingData = (() => {
	let buffer = '';
	return (chunk, handler, addToAnswer) => {
		buffer += chunk.toString();
		const lines = buffer.split('\n');
		buffer = lines.pop();

		for (const line of lines) {
			if (line.startsWith('data: ') && line !== 'data: [DONE]') {
				try {
					const {
						choices: [
							{
								delta: {content = ''},
							},
						],
					} = JSON.parse(line.slice(6));
					if (content) {
						handler(content);
						addToAnswer(content);
					}
				} catch {
					// ignore parsing errors
				}
			}
		}
	};
})();

const handleNonStreamingData = (() => {
	let buffer = '';
	return (chunk, _, addToAnswer) => {
		buffer += chunk.toString();
		if (buffer.endsWith('}')) {
			try {
				const {
					choices: [
						{
							message: {content},
						},
					],
				} = JSON.parse(buffer);
				addToAnswer(content.trim());
				buffer = '';
			} catch {
				// ignore parsing errors
			}
		}
	};
})();

const SYSTEM_PROMPT = 'Answer the question politely and concisely.';

(async () => {
	console.log(`Using LLM at ${LLM_API_BASE_URL}.`);
	console.log('Press Ctrl+D to exit.\n');

	const messages = [{role: 'system', content: SYSTEM_PROMPT}];
	const io = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const qa = () => {
		io.question('>> ', async question => {
			messages.push({role: 'user', content: question});
			const start = Date.now();
			const answer = await chat(
				messages,
				LLM_STREAMING ? string => process.stdout.write(string) : null,
			);
			messages.push({role: 'assistant', content: answer});
			console.log(LLM_STREAMING ? '' : answer);
			LLM_DEBUG && console.log(`\n[${Date.now() - start} ms]\n`);
			qa();
		});
	};

	qa();
})();
