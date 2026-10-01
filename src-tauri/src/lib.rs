use ndarray::{ArrayD, Zip};
use nifti::{writer::WriterOptions, IntoNdArray, NiftiObject, ReaderOptions};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use thiserror::Error;
use uuid::Uuid;

/* ============================================================
ERRORS
============================================================ */

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Json(#[from] serde_json::Error),

    #[error("NIfTI error: {0}")]
    Nifti(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type Result<T> = std::result::Result<T, AppError>;

/* ============================================================
DATA STRUCTURES
============================================================ */

#[derive(Clone, Serialize, Deserialize)]
struct LabelInfo {
    id: u16,
    name: String,
    voxels: u64,
}

#[derive(Clone, Serialize)]
struct DatasetInfo {
    id: String,
    name: String,
    kind: String,
    case_count: usize,
}

#[derive(Clone, Serialize)]
struct CaseInfo {
    id: String,
    ct_path: String,
    seg_path: String,
    labels: Vec<LabelInfo>,
}

#[derive(Serialize)]
struct ImportResult {
    dataset_id: String,
    imported_cases: usize,
    skipped_cases: usize,
}

#[derive(Serialize, Deserialize)]
struct DatasetMeta {
    name: String,
    source: Option<String>,
}

/* ============================================================
APPLICATION PATHS
============================================================ */

fn app_import_root(app: &AppHandle) -> Result<PathBuf> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Message(e.to_string()))?
        .join("imported_datasets");

    fs::create_dir_all(&path)?;

    Ok(path)
}

fn internal_root(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .resolve("resources/internal_cases", BaseDirectory::Resource)
        .map_err(|e| AppError::Message(e.to_string()))
}

/* ============================================================
CASE VALIDATION
============================================================ */

fn valid_preproc(path: &Path) -> bool {
    path.join("ct.nii.gz").is_file()
        && path.join("segmentations_multilabel.nii.gz").is_file()
        && path.join("labels.json").is_file()
}

fn count_cases(root: &Path) -> usize {
    fs::read_dir(root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && valid_preproc(&entry.path().join("preproc"))
        })
        .count()
}

/* ============================================================
LIST DATASETS
============================================================ */

#[tauri::command]
fn list_datasets(app: AppHandle) -> Result<Vec<DatasetInfo>> {
    let mut output = Vec::new();

    /* --------------------------------------------------------
    Included dataset
    -------------------------------------------------------- */

    let internal = internal_root(&app)?;

    if internal.is_dir() {
        let count = count_cases(&internal);

        if count > 0 {
            output.push(DatasetInfo {
                id: "internal".into(),

                name: "Included Cases".into(),

                kind: "internal".into(),

                case_count: count,
            });
        }
    }

    /* --------------------------------------------------------
    Imported datasets
    -------------------------------------------------------- */

    let root = app_import_root(&app)?;

    for entry in fs::read_dir(root)? {
        let entry = entry?;

        if !entry.file_type()?.is_dir() {
            continue;
        }

        let path = entry.path();

        let metadata = fs::read_to_string(path.join("dataset.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<DatasetMeta>(&text).ok());

        let name = metadata
            .map(|m| m.name)
            .unwrap_or_else(|| entry.file_name().to_string_lossy().into_owned());

        output.push(DatasetInfo {
            id: format!("imported:{}", entry.file_name().to_string_lossy()),

            name,

            kind: "imported".into(),

            case_count: count_cases(&path),
        });
    }

    output.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.name.cmp(&b.name)));

    Ok(output)
}

/* ============================================================
DATASET PATH
============================================================ */

fn dataset_path(app: &AppHandle, id: &str) -> Result<PathBuf> {
    if id == "internal" {
        internal_root(app)
    } else if let Some(key) = id.strip_prefix("imported:") {
        Ok(app_import_root(app)?.join(key))
    } else {
        Err(AppError::Message("Unknown dataset".into()))
    }
}

/* ============================================================
LIST CASES
============================================================ */

#[tauri::command]
fn list_cases(app: AppHandle, dataset_id: String) -> Result<Vec<CaseInfo>> {
    let root = dataset_path(&app, &dataset_id)?;

    let mut output = Vec::new();

    if !root.is_dir() {
        return Ok(output);
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;

        if !entry.file_type()?.is_dir() {
            continue;
        }

        let preproc = entry.path().join("preproc");

        if !valid_preproc(&preproc) {
            continue;
        }

        let labels: Vec<LabelInfo> =
            serde_json::from_str(&fs::read_to_string(preproc.join("labels.json"))?)?;

        output.push(CaseInfo {
            id: entry.file_name().to_string_lossy().into_owned(),

            ct_path: preproc.join("ct.nii.gz").to_string_lossy().into_owned(),

            seg_path: preproc
                .join("segmentations_multilabel.nii.gz")
                .to_string_lossy()
                .into_owned(),

            labels,
        });
    }

    output.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(output)
}

/* ============================================================
FIND CASES IN IMPORTED DATASET
============================================================ */

fn case_candidates(root: &Path) -> Result<Vec<PathBuf>> {
    if valid_preproc(&root.join("preproc"))
        || (root.join("ct.nii.gz").is_file() && root.join("segmentations").is_dir())
    {
        return Ok(vec![root.to_path_buf()]);
    }

    let mut cases = Vec::new();

    for entry in fs::read_dir(root)? {
        let entry = entry?;

        if !entry.file_type()?.is_dir() {
            continue;
        }

        let path = entry.path();

        if valid_preproc(&path.join("preproc"))
            || (path.join("ct.nii.gz").is_file() && path.join("segmentations").is_dir())
        {
            cases.push(path);
        }
    }

    cases.sort();

    Ok(cases)
}

/* ============================================================
COPY PREPROCESSED CASE
============================================================ */

fn copy_preproc(source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;

    for name in [
        "ct.nii.gz",
        "segmentations_multilabel.nii.gz",
        "labels.json",
    ] {
        fs::copy(source.join(name), destination.join(name))?;
    }

    Ok(())
}

/* ============================================================
SEGMENTATION NAME
============================================================ */

fn seg_name(path: &Path) -> String {
    let filename = path.file_name().unwrap_or_default().to_string_lossy();

    filename
        .strip_suffix(".nii.gz")
        .or_else(|| filename.strip_suffix(".nii"))
        .unwrap_or(&filename)
        .to_string()
}

/* ============================================================
PREPROCESS RAW TOTALSEGMENTATOR CASE
============================================================ */

fn preprocess_raw(case: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;

    /* --------------------------------------------------------
    CT
    -------------------------------------------------------- */

    let ct_path = case.join("ct.nii.gz");

    fs::copy(&ct_path, destination.join("ct.nii.gz"))?;

    let ct_object = ReaderOptions::new()
        .read_file(&ct_path)
        .map_err(|e| AppError::Nifti(e.to_string()))?;

    let header = ct_object.header().clone();

    let ct_shape = ct_object
        .into_volume()
        .into_ndarray::<f32>()
        .map_err(|e| AppError::Nifti(e.to_string()))?
        .raw_dim();

    /* --------------------------------------------------------
    Segmentation masks
    -------------------------------------------------------- */

    let mut combined = ArrayD::<u16>::zeros(ct_shape.clone());

    let mut files: Vec<PathBuf> = fs::read_dir(case.join("segmentations"))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .map(|name| {
                    let text = name.to_string_lossy();

                    text.ends_with(".nii.gz") || text.ends_with(".nii")
                })
                .unwrap_or(false)
        })
        .collect();

    files.sort();

    if files.is_empty() {
        return Err(AppError::Message(format!(
            "No NIfTI masks found in {}",
            case.display()
        )));
    }

    if files.len() > u16::MAX as usize {
        return Err(AppError::Message("Too many segmentation labels".into()));
    }

    let mut labels = Vec::new();

    /* --------------------------------------------------------
    Combine masks
    -------------------------------------------------------- */

    for (index, path) in files.iter().enumerate() {
        let id = (index + 1) as u16;

        let object = ReaderOptions::new()
            .read_file(path)
            .map_err(|e| AppError::Nifti(format!("{}: {e}", path.display())))?;

        let array = object
            .into_volume()
            .into_ndarray::<f32>()
            .map_err(|e| AppError::Nifti(e.to_string()))?;

        if array.raw_dim() != ct_shape {
            return Err(AppError::Message(format!(
                "Mask dimensions do not match CT: {}",
                path.display()
            )));
        }

        let mut count = 0u64;

        Zip::from(&mut combined)
            .and(&array)
            .for_each(|output, &value| {
                if value != 0.0 {
                    *output = id;

                    count += 1;
                }
            });

        labels.push(LabelInfo {
            id,
            name: seg_name(path),
            voxels: count,
        });
    }

    /* --------------------------------------------------------
    Write multilabel NIfTI
    -------------------------------------------------------- */

    WriterOptions::new(destination.join("segmentations_multilabel.nii.gz"))
        .reference_header(&header)
        .write_nifti(&combined)
        .map_err(|e| AppError::Nifti(e.to_string()))?;

    /* --------------------------------------------------------
    Write labels
    -------------------------------------------------------- */

    fs::write(
        destination.join("labels.json"),
        serde_json::to_vec_pretty(&labels)?,
    )?;

    Ok(())
}

/* ============================================================
IMPORT DATASET
============================================================ */

#[tauri::command]
fn import_dataset(app: AppHandle, source_path: String) -> Result<ImportResult> {
    let source = PathBuf::from(&source_path);

    if !source.is_dir() {
        return Err(AppError::Message("Selected path is not a directory".into()));
    }

    let candidates = case_candidates(&source)?;

    if candidates.is_empty() {
        return Err(AppError::Message(
            "No cases found. Expected \
case/preproc/{ct.nii.gz, labels.json, segmentations_multilabel.nii.gz} \
or case/{ct.nii.gz, segmentations/}."
                .into(),
        ));
    }

    let key = Uuid::new_v4().simple().to_string();

    let destination_root = app_import_root(&app)?.join(&key);

    fs::create_dir_all(&destination_root)?;

    let name = source
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    fs::write(
        destination_root.join("dataset.json"),
        serde_json::to_vec_pretty(&DatasetMeta {
            name: name.clone(),

            source: Some(source_path.clone()),
        })?,
    )?;

    let mut imported = 0;

    let mut skipped = 0;

    for case in candidates {
        let case_id = case
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();

        let destination = destination_root.join(&case_id).join("preproc");

        let result = if valid_preproc(&case.join("preproc")) {
            copy_preproc(&case.join("preproc"), &destination)
        } else {
            preprocess_raw(&case, &destination)
        };

        match result {
            Ok(_) => {
                imported += 1;
            }

            Err(error) => {
                eprintln!("Skipping {case_id}: {error}");

                skipped += 1;

                let _ = fs::remove_dir_all(destination_root.join(&case_id));
            }
        }
    }

    if imported == 0 {
        let _ = fs::remove_dir_all(&destination_root);

        return Err(AppError::Message(
            "No cases could be imported. \
Check that CT and masks have matching dimensions."
                .into(),
        ));
    }

    Ok(ImportResult {
        dataset_id: format!("imported:{key}"),

        imported_cases: imported,

        skipped_cases: skipped,
    })
}

/* ============================================================
REMOVE IMPORTED DATASET
============================================================ */

#[tauri::command]
fn remove_dataset(app: AppHandle, dataset_id: String) -> Result<()> {
    let key = dataset_id
        .strip_prefix("imported:")
        .ok_or_else(|| AppError::Message("Included datasets cannot be removed".into()))?;

    let root = app_import_root(&app)?;

    let path = root.join(key);

    let canonical_root = root.canonicalize()?;

    let canonical_path = path.canonicalize()?;

    if !canonical_path.starts_with(canonical_root) {
        return Err(AppError::Message("Invalid dataset path".into()));
    }

    fs::remove_dir_all(canonical_path)?;

    Ok(())
}

/* ============================================================
READ BINARY FILE

This is used by the NiiVue frontend.

Instead of:

    NiiVue -> asset:// URL -> filesystem

we use:

    Rust -> filesystem -> Vec<u8> -> JavaScript -> NiiVue

This works for both:
    - bundled internal cases
    - imported cases
============================================================ */

#[tauri::command]
fn read_binary_file(path: String) -> Result<Vec<u8>> {
    let path = PathBuf::from(path);

    if !path.is_file() {
        return Err(AppError::Message(format!(
            "File does not exist: {}",
            path.display()
        )));
    }

    Ok(fs::read(path)?)
}

/* ============================================================
RESOLVE CLI PATH

Converts relative command-line paths into absolute paths using
the working directory from which NiftiViewer was launched.

Examples:

    ct.nii.gz
    ./ct.nii.gz
    ../test_data/ct.nii.gz

become absolute filesystem paths before the frontend passes
them to Tauri's filesystem plugin.
============================================================ */

#[tauri::command]
fn resolve_cli_path(path: String) -> Result<String> {
    let path = PathBuf::from(path);

    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    };

    /*
     * canonicalize() resolves:
     *
     *   .
     *   ..
     *   symlinks
     *
     * and also verifies that the path exists.
     */
    let canonical = absolute.canonicalize()?;

    Ok(canonical.to_string_lossy().into_owned())
}

/* ============================================================
TAURI APPLICATION
============================================================ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_datasets,
            list_cases,
            import_dataset,
            remove_dataset,
            read_binary_file,
            resolve_cli_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running TotalSegmentator Viewer");
}
