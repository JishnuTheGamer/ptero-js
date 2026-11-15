import React, { memo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
    faBoxOpen,
    faCopy,
    faEllipsisH,
    faFileArchive,
    faFileCode,
    faFileDownload,
    faLevelUpAlt,
    faPencilAlt,
    faTrashAlt,
    IconDefinition,
} from '@fortawesome/free-solid-svg-icons';
import RenameFileModal from '@/components/server/files/RenameFileModal';
import { ServerContext } from '@/state/server';
import { join } from 'pathe';
import deleteFiles from '@/api/server/files/deleteFiles';
import SpinnerOverlay from '@/components/elements/SpinnerOverlay';
import copyFile from '@/api/server/files/copyFile';
import Can from '@/components/elements/Can';
import getFileDownloadUrl from '@/api/server/files/getFileDownloadUrl';
import useFlash from '@/plugins/useFlash';
import tw from 'twin.macro';
import { FileObject } from '@/api/server/files/loadDirectory';
import useFileManagerSwr from '@/plugins/useFileManagerSwr';
import DropdownMenu from '@/components/elements/DropdownMenu';
import styled from 'styled-components/macro';
import useEventListener from '@/plugins/useEventListener';
import compressFiles from '@/api/server/files/compressFiles';
import decompressFiles from '@/api/server/files/decompressFiles';
import isEqual from 'react-fast-compare';
import ChmodFileModal from '@/components/server/files/ChmodFileModal';
import { Dialog } from '@/components/elements/dialog';

type ModalType = 'rename' | 'move' | 'chmod';

const StyledRow = styled.div<{ $danger?: boolean }>`
    ${tw`p-2 flex items-center rounded`};
    ${(props) =>
        props.$danger ? tw`hover:bg-red-100 hover:text-red-700` : tw`hover:bg-neutral-100 hover:text-neutral-700`};
`;

interface RowProps extends React.HTMLAttributes<HTMLDivElement> {
    icon: IconDefinition;
    title: string;
    $danger?: boolean;
}

const Row = ({ icon, title, ...props }: RowProps) => (
    <StyledRow {...props}>
        <FontAwesomeIcon icon={icon} css={tw`text-xs`} fixedWidth />
        <span css={tw`ml-2`}>{title}</span>
    </StyledRow>
);

import axios from 'axios';
import getFileUploadUrl from '@/api/server/files/getFileUploadUrl';
import { faCloudUploadAlt } from '@fortawesome/free-solid-svg-icons';

// Resume Upload action added in FileDropdownMenu for *.part files
const FileDropdownMenu = ({ file }: { file: FileObject }) => {
    const onClickRef = useRef<DropdownMenu>(null);
    const resumeInputRef = useRef<HTMLInputElement>(null);
    const [showSpinner, setShowSpinner] = useState(false);
    const [modal, setModal] = useState<ModalType | null>(null);
    const [showConfirmation, setShowConfirmation] = useState(false);

    const uuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const { mutate } = useFileManagerSwr();
    const { clearAndAddHttpError, clearFlashes, addFlash } = useFlash();
    const directory = ServerContext.useStoreState((state) => state.files.directory);
    const { pushFileUpload, setUploadProgress, removeFileUpload } = ServerContext.useStoreActions(
        (actions) => actions.files
    );

    const isPartFile = file.isFile && file.name.endsWith('.part') && file.name.length > 5;

    useEventListener(`pterodactyl:files:ctx:${file.key}`, (e: CustomEvent) => {
        if (onClickRef.current) {
            onClickRef.current.triggerMenu(e.detail);
        }
    });

    const doDeletion = () => {
        clearFlashes('files');

        // For UI speed, immediately remove the file from the listing before calling the deletion function.
        // If the delete actually fails, we'll fetch the current directory contents again automatically.
        mutate((files) => files.filter((f) => f.key !== file.key), false);

        deleteFiles(uuid, directory, [file.name]).catch((error) => {
            mutate();
            clearAndAddHttpError({ key: 'files', error });
        });
    };

    const doCopy = () => {
        setShowSpinner(true);
        clearFlashes('files');

        copyFile(uuid, join(directory, file.name))
            .then(() => mutate())
            .catch((error) => clearAndAddHttpError({ key: 'files', error }))
            .then(() => setShowSpinner(false));
    };

    const doDownload = () => {
        setShowSpinner(true);
        clearFlashes('files');

        getFileDownloadUrl(uuid, join(directory, file.name))
            .then((url) => {
                const parsed = new URL(url, window.location.origin);
                const downloadUrl = `${window.location.origin}${parsed.pathname}${parsed.search}`;
                const link = document.createElement('a');
                link.href = downloadUrl;
                link.download = file.name;
                link.rel = 'noopener';
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                link.remove();
            })
            .catch((error) => clearAndAddHttpError({ key: 'files', error }))
            .then(() => setShowSpinner(false));
    };

    const doArchive = () => {
        setShowSpinner(true);
        clearFlashes('files');

        compressFiles(uuid, directory, [file.name])
            .then(() => mutate())
            .catch((error) => clearAndAddHttpError({ key: 'files', error }))
            .then(() => setShowSpinner(false));
    };

    const doUnarchive = () => {
        setShowSpinner(true);
        clearFlashes('files');

        decompressFiles(uuid, directory, file.name)
            .then(() => mutate())
            .catch((error) => clearAndAddHttpError({ key: 'files', error }))
            .then(() => setShowSpinner(false));
    };

    const handleResumeFilePicked = async (selectedFile: File) => {
        clearFlashes('files');
        setShowSpinner(true);
        const controller = new AbortController();
        try {
            const refreshUrl = async () => {
                const raw = await getFileUploadUrl(uuid);
                const parsed = new URL(raw, window.location.origin);
                return { baseUrl: `${window.location.origin}${parsed.pathname}`, token: parsed.searchParams.get('token') || '' };
            };
            let { baseUrl, token } = await refreshUrl();
            const infoRes = await axios.get(`${baseUrl}/part-info`, {
                params: { token, directory, partName: file.name },
            });
            const info = infoRes.data;
            if (!info?.found) {
                addFlash({ key: 'files', type: 'error', title: 'Error', message: `Partial upload '${file.name}' not found.` });
                return;
            }
            if (selectedFile.name !== info.fileName) {
                addFlash({
                    key: 'files',
                    type: 'error',
                    title: 'Verification Failed',
                    message: `Expected '${info.fileName}', but selected '${selectedFile.name}'.`,
                });
                return;
            }
            if (info.totalSize > 0 && selectedFile.size !== info.totalSize) {
                addFlash({
                    key: 'files',
                    type: 'error',
                    title: 'Verification Failed',
                    message: `File size mismatch for '${info.fileName}'. Expected ${info.totalSize} bytes.`,
                });
                return;
            }
            setShowSpinner(false);
            const uploadId = info.uploadId;
            const chunkSize = info.chunkSize || 10 * 1024 * 1024;
            const totalChunks = Math.ceil(selectedFile.size / chunkSize);
            const doneSet = new Set<number>(info.uploadedChunks || []);
            let loadedBase = info.uploadedBytes || 0;
            pushFileUpload({ name: selectedFile.name, data: { abort: controller, loaded: loadedBase, total: selectedFile.size } });
            for (let idx = 0; idx < totalChunks; idx++) {
                if (controller.signal.aborted) {
                    await axios.delete(`${baseUrl}/chunk`, { params: { token, uploadId, directory, fileName: selectedFile.name, deletePart: 'true' } }).catch(() => undefined);
                    throw new DOMException('Aborted', 'AbortError');
                }
                if (doneSet.has(idx)) continue;
                const blob = selectedFile.slice(idx * chunkSize, Math.min(selectedFile.size, (idx + 1) * chunkSize));
                const fd = new FormData();
                fd.append('chunk', blob, selectedFile.name);
                await axios.post(`${baseUrl}/chunk`, fd, {
                    signal: controller.signal,
                    params: { token, uploadId, chunkIndex: idx, totalChunks, chunkSize, totalSize: selectedFile.size, directory, fileName: selectedFile.name },
                });
                loadedBase += blob.size;
                setUploadProgress({ name: selectedFile.name, loaded: Math.min(selectedFile.size, loadedBase) });
            }
            await axios.post(`${baseUrl}/complete`, { uploadId, directory, fileName: selectedFile.name, totalChunks, totalSize: selectedFile.size }, { signal: controller.signal, params: { token } });
            removeFileUpload(selectedFile.name);
            await mutate();
        } catch (error) {
            removeFileUpload(selectedFile.name);
            await mutate().catch(() => undefined);
            if (!controller.signal.aborted) clearAndAddHttpError({ key: 'files', error });
        } finally {
            setShowSpinner(false);
        }
    };

    return (
        <>
            <input
                type={'file'}
                ref={resumeInputRef}
                style={{ display: 'none' }}
                onChange={(e) => {
                    const picked = e.currentTarget.files?.[0];
                    if (picked) void handleResumeFilePicked(picked);
                    e.currentTarget.value = '';
                }}
            />
            <Dialog.Confirm
                open={showConfirmation}
                onClose={() => setShowConfirmation(false)}
                title={`Delete ${file.isFile ? 'File' : 'Directory'}`}
                confirm={'Delete'}
                onConfirmed={doDeletion}
            >
                You will not be able to recover the contents of&nbsp;
                <span className={'font-semibold text-gray-50'}>{file.name}</span> once deleted.
            </Dialog.Confirm>
            <DropdownMenu
                ref={onClickRef}
                renderToggle={(onClick) => (
                    <div css={tw`px-4 py-2 hover:text-white`} onClick={onClick}>
                        <FontAwesomeIcon icon={faEllipsisH} />
                        {modal ? (
                            modal === 'chmod' ? (
                                <ChmodFileModal
                                    visible
                                    appear
                                    files={[{ file: file.name, mode: file.modeBits }]}
                                    onDismissed={() => setModal(null)}
                                />
                            ) : (
                                <RenameFileModal
                                    visible
                                    appear
                                    files={[file.name]}
                                    useMoveTerminology={modal === 'move'}
                                    onDismissed={() => setModal(null)}
                                />
                            )
                        ) : null}
                        <SpinnerOverlay visible={showSpinner} fixed size={'large'} />
                    </div>
                )}
            >
                <Can action={'file.update'}>
                    <Row onClick={() => setModal('rename')} icon={faPencilAlt} title={'Rename'} />
                    <Row onClick={() => setModal('move')} icon={faLevelUpAlt} title={'Move'} />
                    <Row onClick={() => setModal('chmod')} icon={faFileCode} title={'Permissions'} />
                </Can>
                {isPartFile && (
                    <Can action={'file.create'}>
                        <Row
                            onClick={() => resumeInputRef.current && resumeInputRef.current.click()}
                            icon={faCloudUploadAlt}
                            title={'Resume Upload'}
                        />
                    </Can>
                )}
                {file.isFile && (
                    <Can action={'file.create'}>
                        <Row onClick={doCopy} icon={faCopy} title={'Copy'} />
                    </Can>
                )}
                {file.isArchiveType() ? (
                    <Can action={'file.create'}>
                        <Row onClick={doUnarchive} icon={faBoxOpen} title={'Unarchive'} />
                    </Can>
                ) : (
                    <Can action={'file.archive'}>
                        <Row onClick={doArchive} icon={faFileArchive} title={'Archive'} />
                    </Can>
                )}
                {file.isFile && <Row onClick={doDownload} icon={faFileDownload} title={'Download'} />}
                <Can action={'file.delete'}>
                    <Row onClick={() => setShowConfirmation(true)} icon={faTrashAlt} title={'Delete'} $danger />
                </Can>
            </DropdownMenu>
        </>
    );
};

export default memo(FileDropdownMenu, isEqual);
