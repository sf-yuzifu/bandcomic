import prompt from "@system.prompt";
import file from "@system.file";

function detectImageFormat(bytes) {
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
		return "image/jpeg";
	if (
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	)
		return "image/png";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
		return "image/gif";
	if (
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46
	)
		return "image/webp";
	if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
	return "image/jpeg";
}

function base64Encode(input) {
	var chars =
		"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	var bytes = new Uint8Array(input);
	var len = bytes.length;
	var result = "";
	var i;
	for (i = 0; i < len; i += 3) {
		var b1 = bytes[i];
		var b2 = i + 1 < len ? bytes[i + 1] : 0;
		var b3 = i + 2 < len ? bytes[i + 2] : 0;
		result += chars[b1 >> 2];
		result += chars[((b1 & 3) << 4) | (b2 >> 4)];
		result += i + 1 < len ? chars[((b2 & 15) << 2) | (b3 >> 6)] : "=";
		result += i + 2 < len ? chars[b3 & 63] : "=";
	}
	return result;
}

function replaceIfDuplicate(configArray, newConfigObject) {
	const newKey = Object.keys(newConfigObject)[0];
	const singleConfig = { [newKey]: newConfigObject[newKey] };
	let found = false;

	for (let i = 0; i < configArray.length; i++) {
		const existingKey = Object.keys(configArray[i])[0];
		if (existingKey === newKey) {
			configArray[i] = singleConfig;
			found = true;
			break;
		}
	}

	if (!found) {
		configArray.push(singleConfig);
	}

	return configArray;
}

function updateComicsIndexAfterDelete(comicsList, deletedId, comicName) {
	const newList = comicsList.filter((c) => c.id !== deletedId);

	file.writeText({
		uri: "internal://files/comics.json",
		text: JSON.stringify(newList),
		success: () => {
			prompt.showToast({ message: "已删除: " + comicName });
		},
		fail: (data, code) => {
			console.log("更新索引失败, code=" + code);
			prompt.showToast({ message: "文件已删除，但索引更新失败" });
		},
	});
}

export function createDataBridge(interConnect) {
	var bridge = {};

	var _coverQueue = [];
	var _coverIndex = 0;
	var _coverName = "";
	var _coverUri = "";
	var _coverTotalBytes = 0;
	var _coverMime = "image/jpeg";
	var _coverPos = 0;

	function readCoverSlice() {
		var READ = 6144;
		var uri = _coverUri;
		var name = _coverName;
		var pos = _coverPos;
		var total = _coverTotalBytes;
		var len = Math.min(READ, total - pos);
		var isFirst = pos === 0;

		file.readArrayBuffer({
			uri: uri,
			position: pos,
			length: len,
			success: function (bufData) {
				if (!bufData.buffer) {
					_coverIndex++;
					setTimeout(function () {
						sendCoversOneByOne();
					}, 300);
					return;
				}

				var bytes = new Uint8Array(bufData.buffer);
				if (isFirst) {
					_coverMime = detectImageFormat(bytes);
				}
				var header = isFirst ? "data:" + _coverMime + ";base64," : "";
				var b64 = base64Encode(bufData.buffer);
				var totalChunks = Math.ceil(total / READ);
				var chunkIndex = Math.floor(pos / READ);

				interConnect.send({
					data: {
						type: "cover_data_chunk",
						name: name,
						index: chunkIndex,
						total: totalChunks,
						data: header + b64,
					},
					success: function () {
						_coverPos = pos + len;
						if (_coverPos >= total) {
							prompt.showToast({
								message:
									"封面 " +
									(_coverIndex + 1) +
									"/" +
									_coverQueue.length +
									" (" +
									totalChunks +
									"片)",
							});
							_coverIndex++;
							setTimeout(function () {
								sendCoversOneByOne();
							}, 100);
						} else {
							setTimeout(function () {
								readCoverSlice();
							}, 50);
						}
					},
					fail: function () {
						_coverPos = pos + len;
						if (_coverPos >= total) {
							_coverIndex++;
							setTimeout(function () {
								sendCoversOneByOne();
							}, 100);
						} else {
							setTimeout(function () {
								readCoverSlice();
							}, 50);
						}
					},
				});
			},
			fail: function () {
				_coverIndex++;
				setTimeout(function () {
					sendCoversOneByOne();
				}, 30);
			},
		});
	}

	function sendCoversOneByOne() {
		var queue = _coverQueue;
		if (!queue || queue.length === 0) return;

		var idx = _coverIndex;
		if (idx >= queue.length) return;

		var c = queue[idx];

		file.get({
			uri: "internal://files/" + c.id + "/cover",
			success: function (info) {
				_coverName = c.name || "";
				_coverUri = "internal://files/" + c.id + "/cover";
				_coverTotalBytes = info.length || 0;
				_coverMime = "image/jpeg";
				_coverPos = 0;
				readCoverSlice();
			},
			fail: function () {
				_coverIndex = idx + 1;
				setTimeout(function () {
					sendCoversOneByOne();
				}, 30);
			},
		});
	}

	function sendAppDataBatched(comics, sourceList) {
		var i;

		interConnect.send({
			data: {
				type: "app_data_header",
				comic_count: comics.length,
				source_count: sourceList.length,
			},
			success: function () {},
			fail: function () {},
		});

		for (i = 0; i < comics.length; i++) {
			interConnect.send({
				data: { type: "app_data_comic", index: i, comic: comics[i] },
				success: function () {},
				fail: function () {},
			});
		}

		for (i = 0; i < sourceList.length; i++) {
			interConnect.send({
				data: { type: "app_data_source", index: i, source: sourceList[i] },
				success: function () {},
				fail: function () {},
			});
		}

		prompt.showToast({
			message: "发送: comic=" + comics.length + " source=" + sourceList.length,
		});

		interConnect.send({
			data: { type: "app_data_done" },
			success: function () {
				sendCoversOneByOne();
			},
			fail: function () {
				sendCoversOneByOne();
			},
		});
	}

	function readSourcesAndSend(comics) {
		file.readText({
			uri: "internal://files/sources.json",
			success: function (srcData) {
				let sourceList = [];
				try {
					const rawSources = JSON.parse(srcData.text);
					if (Array.isArray(rawSources)) {
						sourceList = rawSources.map(function (s) {
							const key = Object.keys(s)[0];
							const info = s[key];
							return {
								name: (info && info.name) || key,
								apiUrl: (info && info.apiUrl) || "",
							};
						});
					}
				} catch (e) {}

				sendAppDataBatched(comics, sourceList);
			},
			fail: function () {
				sendAppDataBatched(comics, []);
			},
		});
	}

	function sendAppData() {
		prompt.showToast({ message: "request_data，正在读取数据..." });
		_coverIndex = 0;
		_coverQueue = [];
		file.readText({
			uri: "internal://files/comics.json",
			success: function (data) {
				let comicsList = [];
				try {
					comicsList = JSON.parse(data.text);
				} catch (e) {
					comicsList = [];
				}

				if (!Array.isArray(comicsList)) {
					comicsList = [];
				}

				_coverQueue = comicsList;

				if (comicsList.length === 0) {
					readSourcesAndSend([]);
					return;
				}

				const comics = [];
				let pending = comicsList.length;

				comicsList.forEach(function (c) {
					file.get({
						uri: "internal://files/" + c.id,
						recursive: true,
						success: function (fileData) {
							let pageCount = 0;
							let chapterCount = 0;

							if (fileData.subFiles) {
								fileData.subFiles.forEach(function (f) {
									if (f.type === "dir" && f.subFiles && f.subFiles.length > 0) {
										chapterCount++;
									} else if (
										f.type !== "dir" &&
										f.uri.split("/").pop() !== "cover"
									) {
										pageCount++;
									}
								});
							}

							comics.push({
								name: c.name || "",
								page_count: pageCount,
								chapters: chapterCount,
							});

							pending--;
							if (pending === 0) {
								readSourcesAndSend(comics);
							}
						},
						fail: function () {
							comics.push({
								name: c.name || "",
								page_count: 0,
								chapters: 0,
							});

							pending--;
							if (pending === 0) {
								readSourcesAndSend(comics);
							}
						},
					});
				});
			},
			fail: function () {
				readSourcesAndSend([]);
			},
		});
	}

	function handleCookieMessage(rawString, parsedObj) {
		prompt.showToast({ message: "收到Cookie数据" });
		if (!global.cookie) {
			global.cookie = {};
		}

		if (parsedObj) {
			const { type, ...cookieData } = parsedObj;
			Object.assign(global.cookie, cookieData);
		} else {
			const currentSource = global.API_SETTING.using;
			global.cookie[currentSource] = rawString;
		}

		file.writeText({
			uri: "internal://files/cookie.json",
			text: JSON.stringify(global.cookie),
			success: () => {
				prompt.showToast({ message: "Cookie保存成功！" });
			},
			fail: () => {
				prompt.showToast({ message: "Cookie保存失败" });
			},
		});
	}

	function handleSourceConfig(configs) {
		prompt.showToast({ message: "正在保存漫画源配置..." });
		file.readText({
			uri: "internal://files/sources.json",
			success: function (data) {
				let existingConfigs = JSON.parse(data.text);
				configs.forEach(function (newConfig) {
					existingConfigs = replaceIfDuplicate(existingConfigs, newConfig);
				});
				file.writeText({
					uri: "internal://files/sources.json",
					text: JSON.stringify(existingConfigs),
					success: function () {
						configs.forEach(function (newConfig) {
							const key = Object.keys(newConfig)[0];
							global.API_SETTING[key] = newConfig[key];
						});
						bridge.onSourceConfigSaved();
						prompt.showToast({ message: "漫画源配置已保存！" });
					},
					fail: function (code) {
						prompt.showToast({ message: "保存漫画源配置失败: " + code });
					},
				});
			},
			fail: function () {
				const newConfigs = configs;
				file.writeText({
					uri: "internal://files/sources.json",
					text: JSON.stringify(newConfigs),
					success: function () {
						configs.forEach(function (newConfig) {
							const key = Object.keys(newConfig)[0];
							global.API_SETTING[key] = newConfig[key];
						});
						bridge.onSourceConfigSaved();
						prompt.showToast({ message: "漫画源配置已保存！" });
					},
					fail: function (code) {
						prompt.showToast({ message: "保存漫画源配置失败: " + code });
					},
				});
			},
		});
	}

	function handleDeleteComic(parsed) {
		const comicName = parsed.name || "";
		if (!comicName) {
			prompt.showToast({ message: "删除失败：未提供漫画名称" });
			return;
		}

		prompt.showToast({ message: "正在删除: " + comicName });

		file.readText({
			uri: "internal://files/comics.json",
			success: function (data) {
				let comicsList = [];
				try {
					comicsList = JSON.parse(data.text);
				} catch (e) {
					comicsList = [];
				}

				const target = comicsList.find(function (c) {
					return c.name === comicName;
				});
				if (!target) {
					prompt.showToast({ message: "未找到漫画: " + comicName });
					return;
				}

				const folderUri = "internal://files/" + target.id + "/";

				file.access({
					uri: folderUri,
					success: function () {
						file.rmdir({
							uri: folderUri,
							recursive: true,
							success: function () {
								updateComicsIndexAfterDelete(comicsList, target.id, comicName);
							},
							fail: function () {
								console.log("递归删除失败，直接更新索引");
								updateComicsIndexAfterDelete(comicsList, target.id, comicName);
							},
						});
					},
					fail: function () {
						console.log("文件夹不存在，直接更新索引");
						updateComicsIndexAfterDelete(comicsList, target.id, comicName);
					},
				});
			},
			fail: function () {
				prompt.showToast({ message: "读取漫画索引失败" });
			},
		});
	}

	function handleDeleteSource(parsed) {
		const sourceName = parsed.name || "";
		if (!sourceName) {
			prompt.showToast({ message: "删除失败：未提供漫画源名称" });
			return;
		}

		prompt.showToast({ message: "正在删除漫画源: " + sourceName });

		file.readText({
			uri: "internal://files/sources.json",
			success: function (data) {
				let sourceList = [];
				try {
					sourceList = JSON.parse(data.text);
				} catch (e) {
					sourceList = [];
				}

				const newList = sourceList.filter(function (s) {
					const key = Object.keys(s)[0];
					const info = s[key] || {};
					return key !== sourceName && info.name !== sourceName;
				});

				file.writeText({
					uri: "internal://files/sources.json",
					text: JSON.stringify(newList),
					success: function () {
						if (global.API_SETTING[sourceName]) {
							delete global.API_SETTING[sourceName];
							if (global.API_SETTING.using === sourceName) {
								const keys = Object.keys(global.API_SETTING).filter(
									function (k) {
										return k !== "using";
									}
								);
								global.API_SETTING.using = keys[0] || "MangaDex";
							}
							bridge.onSourceConfigSaved();
						}

						prompt.showToast({ message: "已删除漫画源: " + sourceName });
					},
					fail: function (data, code) {
						console.log("更新sources.json失败, code=" + code);
						prompt.showToast({ message: "删除失败，请重试" });
					},
				});
			},
			fail: function () {
				prompt.showToast({ message: "读取漫画源配置失败" });
			},
		});
	}

	function handleMessage(data) {
		const rawData = data.data;
		if (!rawData) {
			prompt.showToast({ message: "收到空消息" });
			return;
		}

		let parsed;
		try {
			parsed = JSON.parse(rawData);
		} catch (e) {
			prompt.showToast({ message: "非JSON，按Cookie处理" });
			handleCookieMessage(rawData, null);
			return;
		}

		const msgType = parsed.type || "(无type)";
		prompt.showToast({ message: "type=" + msgType, duration: 2000 });

		if (msgType === "source_config" && parsed.configs) {
			handleSourceConfig(parsed.configs);
		} else if (msgType === "cookie") {
			handleCookieMessage(null, parsed);
		} else if (msgType === "request_data") {
			sendAppData();
		} else if (msgType === "delete_comic") {
			handleDeleteComic(parsed);
		} else if (msgType === "delete_source") {
			handleDeleteSource(parsed);
		} else {
			prompt.showToast({ message: "未知type，按Cookie处理" });
			handleCookieMessage(null, parsed);
		}
	}

	bridge.handleMessage = handleMessage;

	bridge.onSourceConfigSaved = function () {};

	bridge.cleanTempFiles = function () {
		file.list({
			uri: "internal://files",
			success: function (data) {
				const files = data.fileList || [];
				const keepFiles = [
					"comics.json",
					"settings.json",
					"cookie.json",
					"sources.json",
					"history.json",
				];

				const filesToDelete = files.filter(function (file) {
					const fileName = file.uri.split("/").pop();
					return !keepFiles.includes(fileName);
				});

				if (filesToDelete.length > 0) {
					filesToDelete.forEach(function (files) {
						file.delete({
							uri: files.uri,
						});
					});
					prompt.showToast({
						message: "已清理 " + filesToDelete.length + " 个临时文件",
						duration: 2000,
					});
				}
			},
		});
	};

	return bridge;
}
