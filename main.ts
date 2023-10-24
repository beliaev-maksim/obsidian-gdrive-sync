import {
	App,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	setIcon,
	Setting,
	TFile,
} from "obsidian";

import axios from "axios";

import {
	deleteFile,
	getFile,
	getFilesList,
	getFoldersList,
	getVaultId,
	modifyFile,
	renameFile,
	uploadFile,
	uploadFolder,
} from "./actions";

const getAccessToken = async (refreshToken: string) => {
	var response;
	await axios
		.post(
			"https://red-formula-303406.ue.r.appspot.com/auth/obsidian/refresh-token",
			{
				refreshToken,
			}
		)
		.then((res) => {
			response = res.data;
		})
		.catch((err) => {
			if ((err.code = "ERR_NETWORK")) {
				new Notice("Oops! Network error :(");
				new Notice("Or maybe no refresh token provided?", 5000);
			}

			response = "error";
		});
	return response;
};

interface driveValues {
	refreshToken: string;
	accessToken: string;
	validToken: Boolean;
	vaultId: any;
	vaultInit: boolean;
	filesList: any[];
	rootFolderId: any;
	refresh: boolean;
	refreshTime: string;
	autoRefreshBinaryFiles: string;
	//writingFile: boolean;
	//syncQueue: boolean;
}

const DEFAULT_SETTINGS: driveValues = {
	refreshToken: "",
	accessToken: "",
	validToken: false,
	vaultId: "",
	filesList: [],
	vaultInit: false,
	rootFolderId: "",
	refresh: false,
	refreshTime: "5",
	autoRefreshBinaryFiles: "0",
	//writingFile: false,
	//syncQueue: false,
};

const metaPattern = /^---\n[\s\S]*---/;
const driveDataPattern = /\nlastSync:.*\n/;

export default class driveSyncPlugin extends Plugin {
	settings: driveValues;
	cloudFiles: string[] = [];
	localFiles: string[] = [];
	timer: any = null;
	alreadyRefreshing: boolean = false;
	writingFile: boolean = false;
	syncQueue: boolean = false;
	currentlyUploading: string | null = null; // to mitigate the issue of deleting recently created file while its being uploaded and gets overlaped with the auto-trash function call
	renamingList: string[] = [];
	deletingList: string[] = [];
	statusBarItem = this.addStatusBarItem().createEl("span","sync_icon_still");

	cleanInstall = async () => {
		new Notice("Creating vault in Google Drive...");
		var res = await uploadFolder(
			this.settings.accessToken,
			this.app.vault.getName(),
			this.settings.rootFolderId
		);
		this.settings.vaultId = res;
		new Notice("Vault created!");
		new Notice(
			"Uploading files, this might take time. Please wait...",
			6000
		);
		var filesList = this.app.vault.getFiles();
		for (const file of filesList) {
			const buffer: any = await this.app.vault.readBinary(file);
			await uploadFile(
				this.settings.accessToken,
				file.path,
				buffer,
				this.settings.vaultId
			);
		}
		new Notice("Files uploaded!");
		new Notice("Please reload the plug-in.", 5000);
	};

	refreshAll = async () => {
		if (this.alreadyRefreshing) {
			return;
		} else {
			this.alreadyRefreshing = true;
		}
		this.settings.filesList = await getFilesList(
			// refresh fileslist
			// get list of files in the vault
			this.settings.accessToken,
			this.settings.vaultId
		);
		/* refresh both the files list */
		this.cloudFiles = [];
		this.localFiles = [];

		this.settings.filesList.map((file) => this.cloudFiles.push(file.name));
		this.app.vault
			.getFiles()
			.map((file) => this.localFiles.push(file.path));

		var toDownload = this.cloudFiles.filter(
			(file) =>
				!this.localFiles.includes(file) && // is not currently in vault
				!this.renamingList.includes(file) && // is not currently being renamed
				!this.deletingList.includes(file) // is not currently being deleted
		);

		/* delete tracked but not-in-drive-anymore files */
		this.app.vault.getFiles().map(async (file) => {
			if (
				!this.cloudFiles.includes(file.path) &&
				!this.renamingList.includes(file.path) &&
				file.path != this.currentlyUploading
			) {
				if (file.extension != "md") {
					if (/-synced\.*/.test(file.path)) {
						this.app.vault.delete(file);
						return;
					}
				}
				var content = await this.app.vault.read(file);
				if (driveDataPattern.test(content)) {
					this.app.vault.delete(file);
				}
			}
		});

		/* download new files or files that were renamed */
		if (toDownload.length) {
			new Notice("Downloading missing files", 2500);

			this.settings.refresh = true;
			for (const dFile of toDownload) {
				var id;
				this.settings.filesList.map((file: any) => {
					//console.log(file.name);

					if (file.name == dFile) {
						id = file.id;
					}
				});
				//console.log(id, dFile);

				var file = await getFile(this.settings.accessToken, id);
				await this.app.vault
					.createBinary(file[0], file[1])
					.catch(async () => {
						var path = file[0].split("/").slice(0, -1).join("/");
						//console.log(path);

						await this.app.vault.createFolder(path);
						await this.app.vault.createBinary(file[0], file[1]);
					});
				new Notice(
					`Downloaded ${toDownload.indexOf(dFile) + 1}/${
						toDownload.length
					} files`,
					1000
				);
			}
			new Notice("Download complete :)", 2500);
			// new Notice(
			// 	"Sorry to make you wait for so long. Please continue with your work",
			// 	5000
			// );
			this.settings.refresh = false;
		}
		this.getLatestContent(this.app.workspace.getActiveFile()!);
		this.alreadyRefreshing = false;
		//console.log("refreshing filelist...");
	};
	uploadNewNotesFile = async (newFile: TFile) => {
		if (
			newFile.extension != "md" ||
			newFile.path == this.currentlyUploading
		)
			return; // skip binary files or the file which is already being uploaded
		this.writingFile = true;
		this.currentlyUploading = newFile.path;

		new Notice("Uploading new file to Google Drive!");

		var content = await this.app.vault.read(newFile);

		var metaExists = metaPattern.test(content);
		var driveDataExists = driveDataPattern.test(content);
		if (!metaExists) {
			await this.app.vault.modify(
				newFile,
				`---\nlastSync: ${new Date().toString()}\n---\n` + content
			);
		} else if (!driveDataExists) {
			await this.app.vault.modify(
				newFile,
				content.replace(
					/^---\n/g,
					`---\nlastSync: ${new Date().toString()}\n`
				)
			);
		}

		var buffer: any = await this.app.vault.readBinary(newFile);
		var res = uploadFile(
			this.settings.accessToken,
			newFile.path,
			buffer,
			this.settings.vaultId
		);

		this.writingFile = false;
		this.cloudFiles.push(newFile.path);
		this.settings.filesList = await getFilesList(
			this.settings.accessToken,
			this.settings.vaultId
		);
		this.currentlyUploading = null;

		new Notice("Uploaded!");
	};

	getLatestContent = async (
		file: TFile,
		forced: "forced" | false = false
	) => {
		if (this.cloudFiles.includes(file?.path!) && !this.syncQueue) {
			var index = this.cloudFiles.indexOf(file?.path!);

			var cloudDate = new Date(
				this.settings.filesList[index].modifiedTime
			);
			var content: string;
			var timeStamp: any;
			var isBinaryFile: boolean = false;

			if (file.extension != "md") {
				isBinaryFile = true;
			} else {
				content = await this.app.vault.read(file!);
				timeStamp = content.match(/lastSync:.*/);
			}

			//console.log(cloudDate, new Date(timeStamp![0]));

			if (
				forced == "forced" ||
				(isBinaryFile &&
					parseInt(this.settings.autoRefreshBinaryFiles)) ||
				(timeStamp /* check if timeStamp is present */ &&
					cloudDate.getTime() >
						new Date(timeStamp![0]).getTime() +
							3000) /* allow 3sec delay in 'localDate' */
			) {
				// new Notice("Downloading updated file!");
				var id;
				this.settings.filesList.map((fileItem: any) => {
					if (fileItem.name == file.path) {
						id = fileItem.id;
					}
				});
				var res = await getFile(this.settings.accessToken, id);
				if (this.syncQueue && !isBinaryFile) return;
				//console.log(this.syncQueue);

				await this.app.vault
					.modifyBinary(file, res[1])
					.catch(async () => {
						var path = res[0].split("/").slice(0, -1).join("/");
						//console.log(path);

						await this.app.vault.createFolder(path);
						await this.app.vault.modifyBinary(res[0], res[1]);
					});
				// new Notice("Sync complete :)");
			}
		}
	};

	async onload() {
		await this.loadSettings();

		var res: any = await getAccessToken(this.settings.refreshToken); // get accessToken

		if (res != "error") {
			// if accessToken is available
			this.settings.accessToken = res.access_token;
			this.settings.validToken = true;
			var folders = await getFoldersList(this.settings.accessToken); // look for obsidian folder
			var reqFolder = folders.filter(
				(folder: any) => folder.name == "obsidian"
			);
			if (reqFolder.length) {
				this.settings.rootFolderId = reqFolder[0].id; // set the rootFolder or obsidian folder id
			} else {
				new Notice("Initializing required files"); // else create the folder
				this.settings.rootFolderId = await uploadFolder(
					this.settings.accessToken,
					"obsidian"
				);
			}
		} else {
			// accessToken is not available
			this.settings.accessToken = "";
			this.settings.validToken = false;
		}
		if (this.settings.validToken) {
			this.settings.vaultId = await getVaultId(
				// get vaultId for the current fold
				this.settings.accessToken,
				this.app.vault.getName(),
				this.settings.rootFolderId
			);
			if (this.settings.vaultId == "NOT FOUND") {
				// if vault doesn't exist
				this.settings.vaultInit = false;
				new Notice(
					`Oops! No vaults named ${this.app.vault.getName()} found in Google Drive`
				);
				new Notice(
					"Try initializing vault in Google Drive from plug-in settings :)",
					5000
				);
			} else {
				// if vault exists
				this.settings.vaultInit = true;
				this.refreshAll();
				this.registerInterval(
					window.setInterval(async () => {
						this.refreshAll();
					}, parseInt(this.settings.refreshTime) * 1000)
				);
			}
		}

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new syncSettings(this.app, this));
		if (!this.settings.vaultInit) return;

		/* extract new files to be down/uploaded */
		this.settings.filesList.map((file) => this.cloudFiles.push(file.name));
		this.app.vault
			.getFiles()
			.map((file) => this.localFiles.push(file.path));

		//console.log(toUpload, toDownload);

		this.registerEvent(
			this.app.vault.on("rename", async (newFile, oldpath) => {
				/* this is for newly created files
				as the newly created file is always renamed first
				so it checks that whether the file was already in cloudFiles:
				if it was there we do normal renaming else we upload the new file
				*/
				if (!this.cloudFiles.includes(oldpath)) {
					if (newFile instanceof TFile) {
						this.uploadNewNotesFile(newFile);
					}
					return;
				}

				/* actual renaming of file */
				var id;
				var reqFile = ""; // required for changing the name of the file in the cloudsFile list
				this.settings.filesList.map((file, index) => {
					if (file.name == oldpath) {
						id = file.id;
						reqFile = file.name;
					}
				});
				this.renamingList.push(oldpath);

				this.cloudFiles[this.cloudFiles.indexOf(reqFile)] =
					newFile.path; // update the renamed file in cloudfiles
				await renameFile(this.settings.accessToken, id, newFile.path);
				new Notice("Files/Folders renamed!");

				this.renamingList.splice(this.renamingList.indexOf(oldpath), 1);

				this.settings.filesList = await getFilesList(
					// get list of files in the vault
					this.settings.accessToken,
					this.settings.vaultId
				);
			})
		);
		this.registerEvent(
			this.app.vault.on("create", async (e) => {
				if (e instanceof TFile && !/-synced\.*/.test(e.path)) {
					if (e.extension != "md") {
						new Notice("Uploading new attachment!");
						var buffer: any = await this.app.vault.readBinary(e);
						const fileExtensionPattern = /\..*/;
						var newFileName = e.path.replace(
							fileExtensionPattern,
							"-synced" + e.path.match(fileExtensionPattern)![0]
						);

						this.currentlyUploading = newFileName;

						await this.app.vault.rename(e, newFileName);

						this.cloudFiles.push(newFileName);
						await uploadFile(
							this.settings.accessToken,
							newFileName,
							buffer,
							this.settings.vaultId
						);

						this.currentlyUploading = null;
						new Notice("Uploaded!");
						new Notice(
							"Please make sure that all links to this attachment are updated with the new name: " +
								newFileName
									.match(/\/.*-synced\..*$/)![0]
									.slice(1),
							5000
						);
						this.settings.filesList = await getFilesList(
							this.settings.accessToken,
							this.settings.vaultId
						);
					}
				}
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", async (e) => {
				if (this.settings.refresh) return;
				var id;
				this.settings.filesList.map((file) => {
					if (file.name == e.path) {
						id = file.id;
					}
				});
				this.deletingList.push(e.path);

				var successful = await deleteFile(
					this.settings.accessToken,
					id
				);
				if (successful) new Notice("File deleted!"); // only when actual file from the drive was deleted

				this.deletingList.splice(this.deletingList.indexOf(e.path), 1);

				this.settings.filesList = await getFilesList(
					// get list of files in the vault
					this.settings.accessToken,
					this.settings.vaultId
				);
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", async (e) => {
				if (!this.cloudFiles.includes(e.path)) {
					if (e instanceof TFile) {
						this.uploadNewNotesFile(e);
					}
					return;
				}
				this.syncQueue = true;

				if (
					!(e instanceof TFile) ||
					this.writingFile ||
					e.extension != "md"
				) {
					return;
				}
				if (this.timer) {
					clearTimeout(this.timer);
				}
				this.timer = setTimeout(async () => {
					//console.log("UPDATING FILE");
					this.statusBarItem.classList.replace("sync_icon_still","sync_icon")
					setIcon(this.statusBarItem, "sync");

					var content = await this.app.vault.read(e);

					var metaExists = metaPattern.test(content);
					var driveDataExists = driveDataPattern.test(content);

					this.writingFile = true;

					if (metaExists) {
						if (driveDataExists) {
							this.app.vault.modify(
								e,
								content.replace(
									driveDataPattern,
									`\nlastSync: ${new Date().toString()}\n`
								)
							);
						} else {
							this.app.vault.modify(
								e,
								content.replace(
									/^---\n/g,
									`---\nlastSync: ${new Date().toString()}\n`
								)
							);
						}
					} else {
						this.app.vault.modify(
							e,
							`---\nlastSync: ${new Date().toString()}\n---\n` +
								content
						);
					}
					var id;
					this.settings.filesList.map((file: any) => {
						if (file.name == e.path) {
							id = file.id;
						}
					});
					var buffer = await this.app.vault.readBinary(e);
					while (this.syncQueue) {
						var res = await modifyFile(
							this.settings.accessToken,
							id,
							buffer
						);
						//console.log("refreshed!");
						this.syncQueue = false;
					}

					this.writingFile = false;
					this.timer = null;
					this.statusBarItem.classList.replace("sync_icon", "sync_icon_still")
					setIcon(this.statusBarItem, "checkmark");
				}, 2250);
			})
		);
		this.registerEvent(
			this.app.workspace.on("file-open", async (file) => {
				if (file?.extension == "md") this.getLatestContent(file!);
			})
		);

		// This creates an icon in the left ribbon.
		const uploadEl = this.addRibbonIcon(
			"cloud",
			"Upload Current File",
			async () => {
				var file = this.app.workspace.getActiveFile()!;
				if (!this.cloudFiles.includes(file?.path!)) {
					new ConfirmUpload(this.app, async () => {
						// Called when the user clicks the icon.
						this.uploadNewNotesFile(file);
					}).open();
					return;
				}
				// Called when the user clicks the icon.
				new Notice("Uploading the current file to Google Drive!");
				var buffer: any = await this.app.vault.readBinary(
					this.app.workspace.getActiveFile()!
				);
				var id;
				this.settings.filesList.map((file: any) => {
					if (file.name == this.app.workspace.getActiveFile()?.path) {
						id = file.id;
					}
				});
				var res = await modifyFile(
					this.settings.accessToken,
					id,
					buffer
				);
				new Notice("Uploaded!");
			}
		);
		const downloadEl = this.addRibbonIcon(
			"install",
			"Download Current File",
			async () => {
				var ufile = this.app.workspace.getActiveFile()!;
				if (!this.cloudFiles.includes(ufile?.path!)) {
					new Notice(
						"This file doesn't exist on Google Drive. Please upload it first."
					);
					return;
				}
				// Called when the user clicks the icon.
				new Notice("Downloading current file!");
				await this.getLatestContent(ufile, "forced");
				new Notice("Sync complete :)");
			}
		);

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: "drive-upload-current",
			name: "Upload current file to Google Drive",
			callback: async () => {
				var file = this.app.workspace.getActiveFile()!;
				if (!this.cloudFiles.includes(file?.path!)) {
					new ConfirmUpload(this.app, async () => {
						// Called when the user clicks the icon.
						this.uploadNewNotesFile(file);
					}).open();
					return;
				}
				// Called when the user clicks the icon.
				new Notice("Uploading the current file to Google Drive!");
				var buffer: any = await this.app.vault.readBinary(
					this.app.workspace.getActiveFile()!
				);
				var id;
				this.settings.filesList.map((file: any) => {
					if (file.name == this.app.workspace.getActiveFile()?.path) {
						id = file.id;
					}
				});
				var res = await modifyFile(
					this.settings.accessToken,
					id,
					buffer
				);
				new Notice("Uploaded!");
			},
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: "drive-download-current",
			name: "Download current file from Google Drive",
			callback: async () => {
				var ufile = this.app.workspace.getActiveFile()!;
				if (!this.cloudFiles.includes(ufile?.path!)) {
					new Notice(
						"This file doesn't exist on Google Drive. Please upload it first."
					);
					return;
				}
				// Called when the user clicks the icon.
				new Notice("Downloading current file!");
				await this.getLatestContent(ufile, "forced");
				new Notice("Sync complete :)");
			},
		});

		
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class syncSettings extends PluginSettingTab {
	plugin: driveSyncPlugin;

	constructor(app: App, plugin: driveSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		/* header */
		const head = containerEl.createEl("h1", {
			// heading
			text: "Google Drive Sync",
			cls: "main",
		});

		const sync = containerEl.createEl("div", { cls: "container" });

		if (this.plugin.settings.validToken) {
			// if token is valid
			const sync_text = sync.createEl("div", {
				text: "Logged in",
				cls: "sync_text",
			});
			const sync_icons = sync.createDiv({ cls: "sync_icon_still" });
			setIcon(sync_icons, "checkmark");
		} else {
			// display login link
			const sync_link = sync.createEl("a", {
				text: "Open this link to log in",
				cls: "sync_text",
			});
			sync_link.href =
				"https://red-formula-303406.ue.r.appspot.com/auth/obsidian";
		}

		/* set refresh token input box */
		new Setting(containerEl)
			.setName("Set refresh token")
			.setDesc("Enter the refresh token you got from the link provided")
			.addText((text) =>
				text
					.setPlaceholder("Enter token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
					})
			)
			.addButton((button) =>
				button.setIcon("checkmark").onClick(async () => {
					await this.plugin.saveSettings(); // save refresh token

					sync.innerHTML = "";
					const sync_text = sync.createEl("div", {
						text: "Checking...",
						cls: "sync_text",
					});
					const sync_icons = sync.createDiv({ cls: "sync_icon" });
					setIcon(sync_icons, "sync");
					var res: any = await getAccessToken(
						this.plugin.settings.refreshToken
					); // check for accesstoken
					if (res != "error") {
						// display status accordingly
						this.plugin.settings.accessToken = res.access_token;
						this.plugin.settings.validToken = true;
						new Notice("Logged in successfully");
						sync.innerHTML = "";
						const sync_text = sync.createEl("div", {
							text: "Logged in",
							cls: "sync_text",
						});
						const sync_icons = sync.createDiv({
							cls: "sync_icon_still",
						});
						setIcon(sync_icons, "checkmark");
						new Notice("Please reload the plug-in", 5000);
					} else {
						this.plugin.settings.accessToken = "";
						this.plugin.settings.validToken = false;
						new Notice("Log in failed");
						sync.innerHTML = "";
						const sync_link = sync.createEl("a", {
							text: "Open this link to log in",
							cls: "sync_text",
						});
						sync_link.href =
							"https://red-formula-303406.ue.r.appspot.com/auth/obsidian";
					}
				})
			);
		if (!this.plugin.settings.validToken) return; // bodge 1
		if (!this.plugin.settings.vaultInit) {
			new Setting(containerEl)
				.setName("Initialize vault")
				.setDesc("Create vault and sync all files to Google Drive")
				.addButton((button) => {
					button.setButtonText("Proceed");
					button.onClick(
						async () => await this.plugin.cleanInstall()
					);
				});
			return;
		}
		new Setting(containerEl)
			.setName("Set refresh time")
			.setDesc(
				"Enter the time in seconds after which the plugin checks for changed content. [Reload required]"
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter time")
					.setValue(this.plugin.settings.refreshTime)
					.onChange(async (value) => {
						this.plugin.settings.refreshTime = value;
					})
			);
		new Setting(containerEl)
			.setName("Auto refresh binary files")
			.setDesc(
				"Experimental: Automatically fetch lastest binary files. Currently this plugin doesn't completely support binary file sync."
			)
			.addDropdown((selector) => {
				selector.addOption("1", "Fetch");
				selector.addOption("0", "Don't fetch");
				selector.setValue(this.plugin.settings.autoRefreshBinaryFiles);
				selector.onChange((val) => {
					this.plugin.settings.autoRefreshBinaryFiles = val;
				});
			});
		new Setting(containerEl)
			.setName("Upload all")
			.setDesc(
				"Upload all files to Google Drive, thus DELETING ALL PREVIOUS FILES"
			)
			.addButton((button) =>
				button.setIcon("cloud").onClick(async () => {
					new Notice("Clearing vault in Google Drive...");
					await deleteFile(
						this.plugin.settings.accessToken,
						this.plugin.settings.vaultId
					);
					await this.plugin.cleanInstall();
				})
			);
		new Setting(containerEl)
			.setName("Download all")
			.setDesc(
				"Download all files from Google Drive, thus DELETING ALL PREVIOUS FILES"
			)
			.addButton((button) =>
				button.setIcon("install").onClick(async () => {
					new Notice("Clearing vault...");
					var filesList = this.app.vault.getFiles();
					this.plugin.settings.refresh = true;
					for (const file of filesList) {
						this.app.vault.delete(file, true);
					}
					new Notice("Downloading files...");
					for (const file of this.plugin.settings.filesList) {
						//console.log(file);

						var res = await getFile(
							this.plugin.settings.accessToken,
							file.id
						);
						await this.app.vault
							.createBinary(res[0], res[1])
							.catch(async () => {
								var path = res[0]
									.split("/")
									.slice(0, -1)
									.join("/");
								//console.log(path);

								await this.app.vault.createFolder(path);
								await this.app.vault.createBinary(
									res[0],
									res[1]
								);
							});
					}
					this.plugin.settings.refresh = false;
					new Notice("Sync complete :)");
				})
			);
	}
}

export class ConfirmUpload extends Modal {
	onSubmit: () => void;

	constructor(app: App, onSubmit: () => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Wait a sec!" });

		new Setting(contentEl).setName(
			"Seems like this file is missing from Google Drive. Either it has been created recently or was deleted from your other devices. You can upload it to Google Drive or manually delete it :)"
		);

		new Setting(contentEl)
			.addButton((btn) =>
				btn.setButtonText("Okay").onClick(() => {
					this.close();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Upload")
					.setCta()
					.onClick(() => {
						//console.log(this.app.workspace.getActiveFile());
						this.close();
						this.onSubmit();
					})
			);
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}
