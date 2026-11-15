import axios, { AxiosProgressEvent } from 'axios';
import getFileUploadUrl from '@/api/server/files/getFileUploadUrl';
import tw from 'twin.macro';
import { Button } from '@/components/elements/button/index';
import React, { useEffect, useRef } from 'react';
import { ModalMask } from '@/components/elements/Modal';
import Fade from '@/components/elements/Fade';
import useEventListener from '@/plugins/useEventListener';
import { useFlashKey } from '@/plugins/useFlash';
import useFileManagerSwr from '@/plugins/useFileManagerSwr';
import { ServerContext } from '@/state/server';
import { WithClassname } from '@/components/types';
import Portal from '@/components/elements/Portal';
import { CloudUploadIcon } from '@heroicons/react/outline';
import { useSignal } from '@preact/signals-react';

function isFileOrDirectory(event: DragEvent): boolean {
    if (!event.dataTransfer?.types) {
        return false;
    }

    return event.dataTransfer.types.some((value) => value.toLowerCase() === 'files');
}

export default ({ className }: WithClassname) => {
    const fileUploadInput = useRef<HTMLInputElement>(null);

    const visible = useSignal(false);
    const timeouts = useSignal<NodeJS.Timeout[]>([]);

    const { mutate } = useFileManagerSwr();
    const { addError, clearAndAddHttpError } = useFlashKey('files');

    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const directory = ServerContext.useStoreState((state) => state.files.directory);
    const { clearFileUploads, removeFileUpload, pushFileUpload, setUploadProgress } = ServerContext.useStoreActions(
        (actions) => actions.files
    );

    useEventListener(
        'dragenter',
        (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isFileOrDirectory(e)) {
                visible.value = true;
            }
        },
        { capture: true }
    );

    useEventListener('dragexit', () => (visible.value = false), { capture: true });

    useEventListener('keydown', () => (visible.value = false));

    useEffect(() => {
        return () => timeouts.value.forEach(clearTimeout);
    }, []);

    const CHUNK_LADDER = [
        10 * 1024 * 1024,
        4 * 1024 * 1024,
        1800 * 1024,
        900 * 1024,
        450 * 1024,
        200 * 1024,
        100 * 1024,
        64 * 1024,
        32 * 1024,
        16 * 1024,
    ];

    const getInitialChunkSize = (): number => {
        try {
            const saved = Number(localStorage.getItem('ptero_max_chunk_size') || 0);
            if (saved >= 16 * 1024 && saved <= 10 * 1024 * 1024) return saved;
        } catch {
            // ignore storage errors
        }
        return CHUNK_LADDER[0];
    };

    const nextSmallerChunkSize = (current: number): number | null => {
        const match = CHUNK_LADDER.find((s) => s < current);
        if (match) return match;
        const halved = Math.floor(current / 2);
        return halved >= 16 * 1024 ? halved : null;
    };

    const waitForRetry = (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve, reject) => {
            if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new DOMException('Aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });

    const uploadSingleFileChunked = async (file: File, controller: AbortController) => {
        const refreshUrl = async () => {
            const raw = await getFileUploadUrl(uuid);
            const parsed = new URL(raw, window.location.origin);
            return {
                baseUrl: `${window.location.origin}${parsed.pathname}`,
                token: parsed.searchParams.get('token') || '',
            };
        };

        let { baseUrl, token } = await refreshUrl();

        if (file.size === 0) {
            const fd = new FormData();
            fd.append('files', file);
            await axios.post(`${baseUrl}?token=${encodeURIComponent(token)}`, fd, {
                signal: controller.signal,
                params: { directory },
            });
            setUploadProgress({ name: file.name, loaded: 1 });
            timeouts.value.push(setTimeout(() => removeFileUpload(file.name), 500));
            return;
        }

        let chunkSize = getInitialChunkSize();
        restartWithSmallerChunk: while (true) {
            const storageKey = `ptero_up_${uuid}_${directory}_${file.name}_${file.size}_${file.lastModified}_${chunkSize}`;
            let uploadId = sessionStorage.getItem(storageKey) || '';
            if (!uploadId) {
                uploadId = `up_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
                sessionStorage.setItem(storageKey, uploadId);
            }

            const totalChunks = Math.ceil(file.size / chunkSize);
            let uploadedSet = new Set<number>();
            try {
                const statusRes = await axios.get<{ uploadedChunks?: number[] }>(`${baseUrl}/status`, {
                    signal: controller.signal,
                    params: { token, uploadId, totalChunks, directory, fileName: file.name },
                });
                uploadedSet = new Set(statusRes.data?.uploadedChunks || []);
            } catch {
                uploadedSet = new Set<number>();
            }

            let completedBytes = 0;
            for (let i = 0; i < totalChunks; i++) {
                if (uploadedSet.has(i)) {
                    completedBytes += i === totalChunks - 1 ? file.size - i * chunkSize : chunkSize;
                }
            }
            setUploadProgress({ name: file.name, loaded: completedBytes });

            for (let idx = 0; idx < totalChunks; idx++) {
                if (controller.signal.aborted) {
                    await axios
                        .delete(`${baseUrl}/chunk`, {
                            params: { token, uploadId, directory, fileName: file.name, deletePart: 'true' },
                        })
                        .catch(() => undefined);
                    sessionStorage.removeItem(storageKey);
                    throw new DOMException('Aborted', 'AbortError');
                }
                if (uploadedSet.has(idx)) continue;

                const start = idx * chunkSize;
                const end = Math.min(file.size, start + chunkSize);
                const blob = file.slice(start, end);

                let chunkOk = false;
                let lastErr: unknown;
                for (let attempt = 0; attempt < 8; attempt++) {
                    if (controller.signal.aborted) {
                        await axios
                            .delete(`${baseUrl}/chunk`, {
                                params: { token, uploadId, directory, fileName: file.name, deletePart: 'true' },
                            })
                            .catch(() => undefined);
                        sessionStorage.removeItem(storageKey);
                        throw new DOMException('Aborted', 'AbortError');
                    }
                    if (!navigator.onLine) {
                        await waitForRetry(2000, controller.signal);
                    }
                    const fd = new FormData();
                    fd.append('chunk', blob, file.name);
                    try {
                        await axios.post(`${baseUrl}/chunk`, fd, {
                            signal: controller.signal,
                            params: {
                                token,
                                uploadId,
                                chunkIndex: idx,
                                totalChunks,
                                chunkSize,
                                totalSize: file.size,
                                directory,
                                fileName: file.name,
                            },
                            onUploadProgress: (data: AxiosProgressEvent) => {
                                const partLoaded = Math.min(blob.size, data.loaded || 0);
                                setUploadProgress({
                                    name: file.name,
                                    loaded: Math.min(file.size, completedBytes + partLoaded),
                                });
                            },
                        });
                        completedBytes += blob.size;
                        uploadedSet.add(idx);
                        setUploadProgress({ name: file.name, loaded: Math.min(file.size, completedBytes) });
                        chunkOk = true;
                        break;
                    } catch (err: any) {
                        if (controller.signal.aborted) {
                            await axios
                                .delete(`${baseUrl}/chunk`, {
                                    params: { token, uploadId, directory, fileName: file.name, deletePart: 'true' },
                                })
                                .catch(() => undefined);
                            sessionStorage.removeItem(storageKey);
                            throw err;
                        }
                        const status = err?.response?.status ?? err?.status;
                        const is413 =
                            status === 413 ||
                            (!err?.response &&
                                (/413|payload|entity too large/i.test(String(err?.message || '')) ||
                                    (idx === 0 && attempt >= 1 && chunkSize > 900 * 1024)));
                        if (is413) {
                            const smaller = nextSmallerChunkSize(chunkSize);
                            if (smaller) {
                                await axios
                                    .delete(`${baseUrl}/chunk`, {
                                        params: { token, uploadId, directory, fileName: file.name, deletePart: 'true' },
                                    })
                                    .catch(() => undefined);
                                sessionStorage.removeItem(storageKey);
                                chunkSize = smaller;
                                try {
                                    localStorage.setItem('ptero_max_chunk_size', String(chunkSize));
                                } catch {
                                    // ignore
                                }
                                continue restartWithSmallerChunk;
                            }
                        }
                        if (status === 401 || status === 403) {
                            const refreshed = await refreshUrl();
                            baseUrl = refreshed.baseUrl;
                            token = refreshed.token;
                        }
                        lastErr = err;
                        await waitForRetry(Math.min(10000, 1000 * Math.pow(2, attempt)), controller.signal);
                    }
                }
                if (!chunkOk) throw lastErr;
            }

            await axios.post(
                `${baseUrl}/complete`,
                { uploadId, directory, fileName: file.name, totalChunks, totalSize: file.size },
                { signal: controller.signal, params: { token } }
            );
            sessionStorage.removeItem(storageKey);
            setUploadProgress({ name: file.name, loaded: file.size });
            timeouts.value.push(setTimeout(() => removeFileUpload(file.name), 500));
            return;
        }
    };

    const onFileSubmission = async (files: FileList) => {
        clearAndAddHttpError();
        const list = Array.from(files);
        if (list.some((file) => !file.type && (!file.size || file.size === 4096))) {
            return addError('Folder uploads are not supported.', 'Error');
        }

        const items = list.map((file) => {
            const controller = new AbortController();
            pushFileUpload({
                name: file.name,
                data: { abort: controller, loaded: 0, total: Math.max(1, file.size) },
            });
            return { file, controller };
        });

        try {
            for (const item of items) {
                await uploadSingleFileChunked(item.file, item.controller);
            }
            await mutate();
        } catch (error) {
            const wasManualAbort = items.some((i) => i.controller.signal.aborted);
            items.forEach((i) => removeFileUpload(i.file.name));
            await mutate().catch(() => undefined);
            if (!wasManualAbort) {
                clearAndAddHttpError(error);
            }
        }
    };

    return (
        <>
            <Portal>
                <Fade appear in={visible.value} timeout={75} key={'upload_modal_mask'} unmountOnExit>
                    <ModalMask
                        onClick={() => (visible.value = false)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            e.stopPropagation();

                            visible.value = false;
                            if (!e.dataTransfer?.files.length) return;

                            onFileSubmission(e.dataTransfer.files);
                        }}
                    >
                        <div className={'w-full flex items-center justify-center pointer-events-none'}>
                            <div
                                className={
                                    'flex items-center space-x-4 bg-black w-full ring-4 ring-blue-200 ring-opacity-60 rounded p-6 mx-10 max-w-sm'
                                }
                            >
                                <CloudUploadIcon className={'w-10 h-10 flex-shrink-0'} />
                                <p className={'font-header flex-1 text-lg text-neutral-100 text-center'}>
                                    Drag and drop files to upload.
                                </p>
                            </div>
                        </div>
                    </ModalMask>
                </Fade>
            </Portal>
            <input
                type={'file'}
                ref={fileUploadInput}
                css={tw`hidden`}
                onChange={(e) => {
                    if (!e.currentTarget.files) return;

                    onFileSubmission(e.currentTarget.files);
                    if (fileUploadInput.current) {
                        fileUploadInput.current.files = null;
                    }
                }}
                multiple
            />
            <Button className={className} onClick={() => fileUploadInput.current && fileUploadInput.current.click()}>
                Upload
            </Button>
        </>
    );
};
