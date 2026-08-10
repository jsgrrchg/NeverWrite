use filedescriptor::OwnedHandle;
use std::io;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::os::windows::io::RawHandle;
use std::sync::Mutex;
use tokio::process::Child;
use tokio::process::Command;
use winapi::shared::ntdef::NT_SUCCESS;
use winapi::shared::ntdef::NTSTATUS;
use winapi::um::jobapi2::AssignProcessToJobObject;
use winapi::um::jobapi2::CreateJobObjectW;
use winapi::um::jobapi2::SetInformationJobObject;
use winapi::um::jobapi2::TerminateJobObject;
use winapi::um::winbase::CREATE_SUSPENDED;
use winapi::um::winnt::HANDLE;
use winapi::um::winnt::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use winapi::um::winnt::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use winapi::um::winnt::JobObjectExtendedLimitInformation;

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtResumeProcess(process_handle: HANDLE) -> NTSTATUS;
}

/// Owns a Windows Job Object used to terminate a spawned process tree.
#[derive(Debug)]
pub struct JobObject {
    handle: OwnedHandle,
    // A mutex makes the state check, Job Object API call, and state update
    // atomic with respect to concurrent preserve and terminate requests.
    preserve_descendants: Mutex<bool>,
}

impl JobObject {
    /// Creates a Job Object configured to terminate all members when its last handle closes.
    pub fn create() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.cast()) };

        Self::set_limit_flags(&handle, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)?;

        Ok(Self {
            handle,
            preserve_descendants: Mutex::new(false),
        })
    }

    fn set_limit_flags(handle: &OwnedHandle, flags: u32) -> io::Result<()> {
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = flags;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle().cast(),
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of_mut!(limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Assigns a running process to this job.
    ///
    /// Assignment is not retroactive: descendants created before this call
    /// completes are not guaranteed to become members of the job.
    pub(crate) fn assign_process(&self, process_handle: RawHandle) -> io::Result<()> {
        let assigned = unsafe {
            AssignProcessToJobObject(self.handle.as_raw_handle().cast(), process_handle.cast())
        };
        if assigned == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    /// Starts a process only after assigning it to this Job Object.
    pub fn spawn_contained(&self, command: &mut Command) -> io::Result<Child> {
        command.creation_flags(CREATE_SUSPENDED).kill_on_drop(true);
        let mut child = command.spawn()?;
        let Some(process_handle) = child.raw_handle() else {
            let error = io::Error::other("missing child process handle");
            return Err(self.cleanup_failed_spawn(&mut child, /*assigned_to_job*/ false, error));
        };
        if let Err(error) = self.assign_process(process_handle) {
            return Err(self.cleanup_failed_spawn(&mut child, /*assigned_to_job*/ false, error));
        }

        let status = unsafe { NtResumeProcess(process_handle.cast()) };
        if !NT_SUCCESS(status) {
            let error = io::Error::other(format!(
                "failed to resume contained process: NTSTATUS {status:#x}"
            ));
            return Err(self.cleanup_failed_spawn(&mut child, /*assigned_to_job*/ true, error));
        }

        Ok(child)
    }

    fn cleanup_failed_spawn(
        &self,
        child: &mut Child,
        assigned_to_job: bool,
        spawn_error: io::Error,
    ) -> io::Error {
        let job_cleanup_error = assigned_to_job
            .then(|| self.terminate().err())
            .flatten();
        let process_cleanup_error = if assigned_to_job && job_cleanup_error.is_none() {
            None
        } else {
            child.start_kill().err()
        };

        match (job_cleanup_error, process_cleanup_error) {
            (None, None) => spawn_error,
            (job_error, process_error) => io::Error::new(
                spawn_error.kind(),
                format!(
                    "{spawn_error}; failed to clean up suspended process (job: {}, process: {})",
                    job_error.map_or_else(|| "not applicable".to_string(), |error| error.to_string()),
                    process_error
                        .map_or_else(|| "not applicable".to_string(), |error| error.to_string())
                ),
            ),
        }
    }

    /// Allows contained descendants to keep running after the root exits normally.
    ///
    /// This disables both explicit job termination and kill-on-close for this
    /// object. Calls race safely with [`Self::terminate`]: whichever operation
    /// acquires the state lock first determines whether the process tree is
    /// preserved or terminated.
    pub fn preserve_descendants(&self) -> io::Result<()> {
        let mut preserve_descendants = self
            .preserve_descendants
            .lock()
            .map_err(|_| io::Error::other("job state lock poisoned"))?;
        if *preserve_descendants {
            return Ok(());
        }

        Self::set_limit_flags(&self.handle, 0)?;
        *preserve_descendants = true;
        Ok(())
    }

    /// Terminates every process currently assigned to the job.
    pub fn terminate(&self) -> io::Result<()> {
        let preserve_descendants = self
            .preserve_descendants
            .lock()
            .map_err(|_| io::Error::other("job state lock poisoned"))?;
        if *preserve_descendants {
            return Ok(());
        }

        let terminated = unsafe {
            TerminateJobObject(self.handle.as_raw_handle().cast(), /*uExitCode*/ 1)
        };
        if terminated == 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }
}

impl AsRawHandle for JobObject {
    fn as_raw_handle(&self) -> RawHandle {
        self.handle.as_raw_handle()
    }
}
