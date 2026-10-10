pipeline {
    agent {
            kubernetes {
                inheritFrom 'frontend'
            }
        }
    environment {
        IMAGE_REPO_NAME = "app-distributor"
        BUCKET_NAME = "gobimbel-spin"
        HELM_STORE_PATH = "values/app-distributor"
        AWS_CREDENTIALS_ID = "jenkins-aws"
        APP_NAME="app-distributor"
    }
    stages {
        stage('Clone repository') {
            steps {
                script {
                    try {
                        checkout scm
                    } catch (Exception e) {
                        BUILD_ERROR = "Failed to clone repository: ${e.message}"
                        error "Failed to clone repository: ${e.message}"
                    }
                }
            }
        }

        stage('Push values to S3') {
            when {
                anyOf {
                    branch 'main'
                }
                changeset 'helm/**/*.yaml'
            }
            steps {
                script {
                    try {
                        withAWS(region: "ap-southeast-1", credentials: "${AWS_CREDENTIALS_ID}") {
                            s3Upload(file: './helm', bucket: "${BUCKET_NAME}", path: "${HELM_STORE_PATH}")
                        }
                    } catch (Exception e) {
                        BUILD_ERROR = "Failed to upload to S3: ${e.message}"
                        error "Failed to upload to S3: ${e.message}"
                    }
                }
            }
        }

        stage('Code Scan'){
            when {
                anyOf {
                    branch 'main'
                }
            }
            environment {
                scannerHome = tool 'sonar-scanner'
            }
            steps {
                script {
                    try {
                        withSonarQubeEnv('sonar-staging'){
                            sh "${scannerHome}/bin/sonar-scanner -Dsonar.plugins.downloadOnlyRequired=true -Dsonar.projectKey=${APP_NAME} -Dsonar.exclusions=node_modules/**,dist/**,helm/**,deploy/**,Jenkinsfile -Dsonar.languages=ts"
                        }
                    } catch (Exception e) {
                        BUILD_ERROR = "Failed to scanning source code: ${e.message}"
                        error "Failed to scanning source code: ${e.message}"
                    }
                }
            }
        }

        stage('Building Image') {
            when {
                anyOf {
                    branch 'main'
                }
            }
            steps {
                script {
                    container('dind') {
                        try {
                            withCredentials([string(credentialsId: 'build-env', variable: 'SECRET')]) {
                                writeFile file: '.env.base64', text: "${SECRET}"
                                withEnv(['DOCKER_BUILDKIT=1']) {
                                    app = docker.build("${IMAGE_REPO_NAME}", "--secret id=env,src=.env.base64 .")
                                }
                            }
                        } catch (Exception e) {
                            BUILD_ERROR = "Failed to build Docker image: ${e.message}"
                            error "Failed to build Docker image: ${e.message}"
                        } finally {
                            sh 'rm -f .env.base64'
                        }
                    }
                }
            }
        }

        // stage('Install Trivy & Scan Image') {
        //     when {
        //         anyOf {
        //             branch 'main'
        //         }
        //     }
        //     steps {
        //         container('dind'){
        //             sh '''
        //             curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /tmp
        //             /tmp/trivy image --format template --template "@trivy-report.tpl" -o trivy-report.html ${IMAGE_REPO_NAME}
        //             '''
        //         }
        //     }
        //     post {
        //         always {
        //             archiveArtifacts artifacts: 'trivy-report.html', allowEmptyArchive: true
        //             publishHTML(target: [
        //                 allowMissing: true,
        //                 alwaysLinkToLastBuild: true,
        //                 keepAll: true,
        //                 reportDir: "${WORKSPACE}",
        //                 reportFiles: 'trivy-report.html',
        //                 reportName: 'Trivy-Report',
        //                 reportTitles: 'Trivy-Report'
        //             ])
        //         }
        //     }
        // }

        stage('Push Image to Repository') {
            when {
                anyOf {
                    branch 'main'
                }
            }
            steps {
                script {
                    container('dind') {
                        try {
                            pushDockerImage(app)
                        } catch (Exception e) {
                            BUILD_ERROR = "Failed to push Docker image to repository: ${e.message}"
                            error "Failed to push Docker image to repository: ${e.message}"
                        }
                    }
                }
            }
        }
    }

    post{
        always {
            script {
                CONSOLE_LOG = "${env.BUILD_URL}/console"
                BUILD_STATUS = currentBuild.currentResult
                BUILD_ERROR = (BUILD_STATUS == 'SUCCESS') ? "NA" : BUILD_ERROR
                
                // Get today's date in the desired format
                def today = sh(script: 'date +"%b %d"', returnStdout: true).trim()

    
            }
            sendSlackNotification()
        }
    }
}



def pushDockerImage(app) {
    withCredentials([string(credentialsId: 'AWS_ACCOUNT_ID', variable: 'AWS_ACCOUNT_ID')]) {
        docker.withRegistry("https://${AWS_ACCOUNT_ID}.dkr.ecr.ap-southeast-1.amazonaws.com", "ecr:ap-southeast-1:${AWS_CREDENTIALS_ID}") {
            app.push('latest')
        }
    }
}

def sendSlackNotification() {
    def status = currentBuild.currentResult
    def color = (status == "SUCCESS") ? 'good' : 'danger'
    def errorDescription = (status == "FAILURE") ? "\n Error description: *${BUILD_ERROR}*" : ""
    
    def buildSummary = "Job: ${env.JOB_NAME}\n Status: *${status}*${errorDescription}\n Build Report: ${env.BUILD_URL}Build-Report"
    
    slackSend(color: color, message: buildSummary, channel: '#cicd')
}